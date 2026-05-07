import { type Page, expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';

// Verifies that signing out wipes the previous user's IDB rows so the next user on the same
// device cannot see them. Pre-fix, items/routines/people/workContexts/syncCursors and queued
// syncOperations all leaked across sign-outs because removeAccount() only cleared the account
// directory.

const CLIENT_URL = 'http://localhost:4173';

interface IdbCounts {
    items: number;
    routines: number;
    people: number;
    workContexts: number;
    syncCursorPresent: boolean;
    syncOps: number;
    deviceMetaPresent: boolean;
}

async function readUserIdbCounts(page: Page, userId: string): Promise<IdbCounts> {
    return page.evaluate(async (uid) => {
        type Cursor = { userId: string };
        type Op = { userId: string };
        type Harness = {
            db: {
                getAllFromIndex(store: 'items' | 'routines' | 'people' | 'workContexts', index: 'userId', key: string): Promise<unknown[]>;
                get(store: 'syncCursors', key: string): Promise<Cursor | undefined>;
                get(store: 'deviceMeta', key: 'local'): Promise<unknown>;
                getAll(store: 'syncOperations'): Promise<Op[]>;
            };
        };
        const harness = (window as unknown as { __gtd: Harness }).__gtd;
        const [items, routines, people, workContexts, syncCursor, syncOps, deviceMeta] = await Promise.all([
            harness.db.getAllFromIndex('items', 'userId', uid),
            harness.db.getAllFromIndex('routines', 'userId', uid),
            harness.db.getAllFromIndex('people', 'userId', uid),
            harness.db.getAllFromIndex('workContexts', 'userId', uid),
            harness.db.get('syncCursors', uid),
            harness.db.getAll('syncOperations'),
            harness.db.get('deviceMeta', 'local'),
        ]);
        return {
            items: items.length,
            routines: routines.length,
            people: people.length,
            workContexts: workContexts.length,
            syncCursorPresent: syncCursor !== undefined,
            syncOps: syncOps.filter((o) => o.userId === uid).length,
            deviceMetaPresent: deviceMeta !== undefined,
        };
    }, userId);
}

async function readActiveAccountId(page: Page): Promise<string> {
    const id = await page.evaluate(() => {
        type Harness = { getActiveAccountId(): Promise<string | null> };
        return (window as unknown as { __gtd: Harness }).__gtd.getActiveAccountId();
    });
    if (!id) {
        throw new Error('No active account id');
    }
    return id;
}

async function openAccountMenu(page: Page): Promise<void> {
    const trigger = page.getByTestId('accountSwitcherTrigger').locator('visible=true').first();
    await trigger.click();
}

test.describe('sign-out wipes the previous user\'s IDB rows', () => {
    test('items / routines / people / workContexts / syncCursor / syncOperations are gone after sign-out; deviceMeta survives', async ({ browser }) => {
        const email = `signout-wipe-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(`${CLIENT_URL}/inbox`);
            const userId = await readActiveAccountId(page);

            // Seed entities under this user via the dev harness so we have something to wipe.
            await page.evaluate(async () => {
                type Harness = {
                    collect(title: string): Promise<unknown>;
                    createPerson(fields: { name: string }): Promise<unknown>;
                    createWorkContext(name: string): Promise<unknown>;
                    createRoutine(fields: { title: string; rrule: string; routineType: 'nextAction' | 'calendar'; template: object }): Promise<unknown>;
                    flush(): Promise<void>;
                };
                const h = (window as unknown as { __gtd: Harness }).__gtd;
                await h.collect('seed inbox');
                await h.createPerson({ name: 'seed person' });
                await h.createWorkContext('seed-ctx');
                await h.createRoutine({ title: 'seed routine', rrule: 'FREQ=DAILY', routineType: 'nextAction', template: {} });
                await h.flush();
            });

            // Sanity check: rows exist before sign-out.
            const before = await readUserIdbCounts(page, userId);
            expect(before.items).toBeGreaterThan(0);
            expect(before.routines).toBeGreaterThan(0);
            expect(before.people).toBeGreaterThan(0);
            expect(before.workContexts).toBeGreaterThan(0);
            expect(before.syncCursorPresent).toBe(true);
            expect(before.deviceMetaPresent).toBe(true);

            // Sign out via the account switcher.
            await openAccountMenu(page);
            const signOut = page.getByRole('menuitem', { name: 'Sign out', exact: true });
            await signOut.waitFor({ state: 'visible' });
            await signOut.click();
            await page.waitForURL(`${CLIENT_URL}/login`, { timeout: 10_000 });

            // After sign-out, IDB still answers (only accounts are cleared) but every user-scoped
            // row for this userId must be gone — and deviceMeta must remain so re-sign-in keeps
            // the same deviceId.
            const after = await readUserIdbCounts(page, userId);
            expect(after.items).toBe(0);
            expect(after.routines).toBe(0);
            expect(after.people).toBe(0);
            expect(after.workContexts).toBe(0);
            expect(after.syncCursorPresent).toBe(false);
            expect(after.syncOps).toBe(0);
            expect(after.deviceMetaPresent).toBe(true);
        });
    });
});
