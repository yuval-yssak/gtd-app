import { type APIRequestContext, type Browser, type BrowserContext, expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withOneLoggedInDevice } from './helpers/context';

const API_URL = 'http://localhost:4000';

/**
 * Phase 4 e2e for /v1/operations/batch. Asserts: heterogeneous batch happy-path (workContext +
 * items referencing it lands atomically), 403 atomicity (a missing scope rejects before any
 * write), and 400 atomicity (a Zod failure rejects before any write).
 */

interface Plaintext {
    id: string;
    plaintext: string;
}

async function mintBatchToken(request: APIRequestContext, scopes: string[]): Promise<Plaintext> {
    const res = await request.post(`${API_URL}/account/tokens`, { data: { label: 'phase4-batch', scopes } });
    expect(res.status()).toBe(200);
    return (await res.json()) as Plaintext;
}

async function withBearerOnlyContext(browser: Browser, fn: (ctx: BrowserContext) => Promise<void>): Promise<void> {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
        await fn(ctx);
    } finally {
        await ctx.close();
    }
}

const NOW = '2099-04-01T00:00:00.000Z';

test.describe('public /v1/operations/batch', () => {
    test('heterogeneous batch: workContext + 3 items referencing it land atomically', async ({ browser }) => {
        const email = `public-api-batch-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            const sessionRes = await page.context().request.get(`${API_URL}/auth/get-session`);
            const sessionBody = (await sessionRes.json()) as { user: { id: string } };
            const userId = sessionBody.user.id;
            const { plaintext } = await mintBatchToken(page.context().request, ['items.capture', 'contexts.write']);

            await withBearerOnlyContext(browser, async (apiContext) => {
                const auth = { headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' } };
                const stamp = dayjs().valueOf();
                const wcId = `wc-batch-${stamp}`;
                const itemIds = ['a', 'b', 'c'].map((suffix) => `it-${suffix}-${stamp}`);
                const ops = [
                    {
                        entityType: 'workContext',
                        opType: 'create',
                        entityId: wcId,
                        snapshot: { _id: wcId, user: userId, name: 'phase4 batch ctx', createdTs: NOW, updatedTs: NOW },
                    },
                    ...itemIds.map((id, i) => ({
                        entityType: 'item',
                        opType: 'create',
                        entityId: id,
                        snapshot: { _id: id, user: userId, status: 'inbox', title: `batch ${i}`, createdTs: NOW, updatedTs: NOW },
                    })),
                ];
                const res = await apiContext.request.post(`${API_URL}/v1/operations/batch`, { ...auth, data: { ops } });
                expect(res.status()).toBe(200);
                const body = (await res.json()) as { ok: boolean; count: number };
                expect(body.ok).toBe(true);
                expect(body.count).toBe(4);
            });
        });
    });

    test('403 atomicity: missing scope rejects the entire batch with no partial writes', async ({ browser }) => {
        const email = `public-api-batch-403-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            const sessionRes = await page.context().request.get(`${API_URL}/auth/get-session`);
            const { user } = (await sessionRes.json()) as { user: { id: string } };
            // Token scoped to capture + contexts.write + contexts.read (for the no-partial-writes
            // verification GET below) but NOT people.write — so the batch will 403 on the person op.
            const { plaintext } = await mintBatchToken(page.context().request, ['items.capture', 'contexts.write', 'contexts.read']);

            await withBearerOnlyContext(browser, async (apiContext) => {
                const auth = { headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' } };
                const wcId = `wc-403-${dayjs().valueOf()}`;
                const personId = `p-403-${dayjs().valueOf()}`;
                const ops = [
                    {
                        entityType: 'workContext',
                        opType: 'create',
                        entityId: wcId,
                        snapshot: { _id: wcId, user: user.id, name: '403 ctx', createdTs: NOW, updatedTs: NOW },
                    },
                    {
                        entityType: 'person',
                        opType: 'create',
                        entityId: personId,
                        snapshot: { _id: personId, user: user.id, name: '403 person', createdTs: NOW, updatedTs: NOW },
                    },
                ];
                const res = await apiContext.request.post(`${API_URL}/v1/operations/batch`, { ...auth, data: { ops } });
                expect(res.status()).toBe(403);
                const body = (await res.json()) as { code: string; requiredScope: string };
                expect(body.code).toBe('forbidden_scope');
                expect(body.requiredScope).toBe('people.write');

                // Critically: NEITHER op was applied. The batch endpoint must be atomic on scope.
                const wcRead = await apiContext.request.get(`${API_URL}/v1/work-contexts/${wcId}`, {
                    headers: { Authorization: `Bearer ${plaintext}` },
                });
                expect(wcRead.status()).toBe(404);
            });
        });
    });

    test('400 atomicity: a Zod-failing op rejects the entire batch with no partial writes', async ({ browser }) => {
        const email = `public-api-batch-400-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            const sessionRes = await page.context().request.get(`${API_URL}/auth/get-session`);
            const { user } = (await sessionRes.json()) as { user: { id: string } };
            // Same as the 403 test — add items.read so the verification GET below isn't masked by 403.
            const { plaintext } = await mintBatchToken(page.context().request, ['items.capture', 'items.read', 'contexts.write']);

            await withBearerOnlyContext(browser, async (apiContext) => {
                const auth = { headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' } };
                const validId = `valid-${dayjs().valueOf()}`;
                const invalidId = `invalid-${dayjs().valueOf()}`;
                const ops = [
                    {
                        entityType: 'item',
                        opType: 'create',
                        entityId: validId,
                        snapshot: { _id: validId, user: user.id, status: 'inbox', title: 'valid', createdTs: NOW, updatedTs: NOW },
                    },
                    // Missing required `name` — Zod rejects.
                    {
                        entityType: 'workContext',
                        opType: 'create',
                        entityId: invalidId,
                        snapshot: { _id: invalidId, user: user.id, createdTs: NOW, updatedTs: NOW },
                    },
                ];
                const res = await apiContext.request.post(`${API_URL}/v1/operations/batch`, { ...auth, data: { ops } });
                expect(res.status()).toBe(400);
                expect(((await res.json()) as { code: string }).code).toBe('invalid_operation');

                // The valid op must NOT have been applied — strict-mode validates the whole batch first.
                const validRead = await apiContext.request.get(`${API_URL}/v1/items/${validId}`, {
                    headers: { Authorization: `Bearer ${plaintext}` },
                });
                expect(validRead.status()).toBe(404);
            });
        });
    });
});
