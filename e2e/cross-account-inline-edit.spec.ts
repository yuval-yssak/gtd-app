import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import type { StoredItem } from '../client/src/types/MyDB';
import { resetServerForEmails, withTwoAccountsOnOneDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Regression: editing an item owned by a non-active Better Auth account through the regular
// inline-edit path (not the cross-account reassign flow) used to fail with `POST /sync/push 400`
// because `queueSyncOp` fired its immediate flush under the active session. The server's misroute
// guard (`api-server/src/routes/sync.ts` ≈196) compares `snapshot.userId` to `session.user.id`
// and rejects the batch when they disagree. The fix routes the immediate flush through
// `syncSingleUser`, which pivots the cookie via `multiSession.setActive` before the push.
//
// This spec drives the failure mode end-to-end: a multi-session device with active=alice, an
// item owned by bob in IDB, an inline edit via `__gtd.updateItem`. Pre-fix, the recorded sync
// push response was 400. Post-fix, it is 200 and the server reflects the edit.

const DEV_SEED_ENTITY_URL = 'http://localhost:4000/dev/reassign/seed-entity';
const DEV_FIND_ENTITY_URL = 'http://localhost:4000/dev/reassign/find-entity';
const INBOX_URL = 'http://localhost:4173/inbox';

interface ServerItem {
    _id: string;
    user: string;
    title: string;
}

async function seedItemOnServer(userId: string, title: string): Promise<string> {
    const id = `seed-${Math.random().toString(36).slice(2, 10)}`;
    const now = dayjs().toISOString();
    const doc = { _id: id, user: userId, status: 'inbox', title, createdTs: now, updatedTs: now };
    const res = await fetch(DEV_SEED_ENTITY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'items', doc }),
    });
    if (!res.ok) {
        throw new Error(`seed item ${res.status}: ${await res.text()}`);
    }
    return id;
}

async function fetchServerItem(entityId: string): Promise<ServerItem | null> {
    const res = await fetch(`${DEV_FIND_ENTITY_URL}?collection=items&entityId=${entityId}`);
    if (!res.ok) {
        return null;
    }
    const body = (await res.json()) as { doc: ServerItem | null };
    return body.doc;
}

/**
 * Records every `POST /sync/push` response so the test can assert no 400 was returned during
 * the inline edit. Pre-fix, the bad request happened during the fire-and-forget flush kicked
 * off by `queueSyncOp`, so it never surfaced as a thrown error in the test — but the server
 * silently dropped the op and the user saw a stale UI until the next mount-time orchestrator pass.
 */
function captureSyncPushResponses(page: Page): { responses: number[] } {
    const captured: number[] = [];
    page.on('response', (res) => {
        const url = res.url();
        if (url.endsWith('/sync/push')) {
            captured.push(res.status());
        }
    });
    return { responses: captured };
}

/** Waits until both per-user SSE channels are open so subsequent sync ops have a stable baseline. */
async function waitForBothSseChannels(page: Page, userIdA: string, userIdB: string): Promise<void> {
    await page.waitForFunction(
        ([a, b]) => {
            const harness = (window as unknown as { __gtd: { sseChannelUserIds(): string[] } }).__gtd;
            const ids = new Set(harness.sseChannelUserIds());
            return ids.has(a as string) && ids.has(b as string);
        },
        [userIdA, userIdB] as const,
        { timeout: 10_000 },
    );
}

test.describe('Cross-account inline edit dispatches through syncSingleUser', () => {
    test('editing a non-active account’s item routes the flush through the session pivot — push returns 200, server reflects the edit', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const aliceEmail = `inline-edit-alice-${stamp}@example.com`;
        const bobEmail = `inline-edit-bob-${stamp}@example.com`;
        await resetServerForEmails([aliceEmail, bobEmail]);
        await withTwoAccountsOnOneDevice(browser, [aliceEmail, bobEmail], async (page, { active: alice, secondary: bob }) => {
            const pushSpy = captureSyncPushResponses(page);

            // Seed an item owned by bob directly on the server. The boot-time multi-account pull
            // brings it into IDB under bob's userId on this device — even though the active session
            // is alice. That asymmetry is exactly the failure mode the dispatch guard fixes.
            const itemId = await seedItemOnServer(bob.userId, 'Original title');

            await page.goto(INBOX_URL);
            await waitForBothSseChannels(page, alice.userId, bob.userId);
            // Force a multi-account pull so the seeded item lands in IDB under bob.
            await gtd.pull(page);

            // Read the row directly from IDB. `gtd.listItems` filters by the *active* user — that's
            // alice here, so it would never see bob's row. We need bob's full StoredItem to drive
            // `updateItem` with the snapshot the queueSyncOp dispatch will tag with `userId=bob`.
            // The native indexedDB API is callback-based; wrap it in a Promise inline so the
            // helper stays self-contained (no extra fixture or harness method to maintain).
            const bobItem = await page.evaluate<StoredItem | undefined, string>(
                (id) =>
                    new Promise<StoredItem | undefined>((resolve, reject) => {
                        const open = indexedDB.open('gtd-app');
                        open.onerror = () => reject(open.error);
                        open.onsuccess = () => {
                            const db = open.result;
                            const tx = db.transaction('items', 'readonly');
                            const req = tx.objectStore('items').get(id);
                            req.onerror = () => reject(req.error);
                            req.onsuccess = () => resolve(req.result as StoredItem | undefined);
                        };
                    }),
                itemId,
            );
            expect(bobItem).toBeDefined();
            expect(bobItem?.userId).toBe(bob.userId);
            // Narrowing guard: the previous `expect(bobItem).toBeDefined()` already throws if it
            // is undefined, so by this line `bobItem` is guaranteed to be a StoredItem.
            if (!bobItem) {
                throw new Error('unreachable — toBeDefined would have thrown');
            }

            // The active session at this point is alice. Drive the inline edit through the harness
            // — same code path as a calendar/inbox UI edit, which calls `updateItem(db, item)` and
            // queues an op tagged with `userId: bob.userId`.
            const beforeUpdateCallCount = pushSpy.responses.length;
            const updated: StoredItem = { ...bobItem, title: 'Inline-edited via alice session' };
            await gtd.updateItem(page, updated);

            // Don't call `gtd.flush` — its harness implementation runs an unscoped flushSyncQueue
            // which would itself hit the misroute guard for the same reason this spec is regressing
            // against. Instead, rely on the dispatch fired by `queueSyncOp` to drive the round-trip:
            // it routes through `syncSingleUser`, which pivots the cookie to bob, pushes scoped to
            // bob's userId, and restores alice's session before resolving.

            // Server-side: poll until the seeded row reflects the edit. Pre-fix the push returned
            // 400 and the title never changed; post-fix the title flips because the dispatch's
            // `syncSingleUser` pushed under bob's session.
            await expect.poll(async () => (await fetchServerItem(itemId))?.title, { timeout: 10_000 }).toBe('Inline-edited via alice session');
            const moved = await fetchServerItem(itemId);
            expect(moved?.user).toBe(bob.userId);

            // The new push must have happened and must have succeeded. Pre-fix every push during
            // this window came back 400 with the misroute-guard error; post-fix the dispatch
            // pivots the cookie to bob first so all responses are 200.
            const newResponses = pushSpy.responses.slice(beforeUpdateCallCount);
            expect(newResponses.length).toBeGreaterThan(0);
            for (const status of newResponses) {
                expect(status).toBe(200);
            }

            // The active session must be restored to alice — `syncSingleUser`'s try/finally puts
            // the cookie back so subsequent UI work continues under the user-selected account.
            const activeAfter = await gtd.getActiveAccountId(page);
            expect(activeAfter).toBe(alice.userId);
        });
    });
});
