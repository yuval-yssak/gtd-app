import { type APIRequestContext, type Browser, type BrowserContext, expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withOneLoggedInDevice } from './helpers/context';

const API_URL = 'http://localhost:4000';

/**
 * End-to-end coverage for the public /v1 API. The critical assertion is that a write driven
 * by an external bearer-token caller flows through `notifyChange` → SSE → the original
 * logged-in tab, picking up `IndexedDB` and showing the item live. Everything else (idempotency,
 * status filtering, complete) is unit-tested in `api-server/src/tests/v1Items.test.ts`; we
 * still drive each endpoint here so a deploy regression on routing/CORS/middleware fails loudly.
 *
 * GCal pushback is intentionally NOT asserted here — that path is non-/v1-specific and is covered
 * by the manually-run smoke tests under `e2e/gcal-sync-smoke/`.
 */

interface Plaintext {
    id: string;
    plaintext: string;
}

async function mintTokenViaSession(request: APIRequestContext, label: string): Promise<Plaintext> {
    // Mint with the full read+write set by default — most tests in this spec exercise the entire
    // /v1 surface (POST + GET + PATCH + complete). Scope-restricted callers are tested in the
    // dedicated PATCH spec further down (`mintTokenViaSession` callers there opt in to capture-only
    // explicitly).
    const res = await request.post(`${API_URL}/account/tokens`, {
        data: { label, scopes: ['items.capture', 'items.read', 'items.write'] },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Plaintext;
    return body;
}

/** Opens a fresh browser context with no cookies/origins so /v1 calls exercise the bearer-only
 * auth path. A cookie-bearing context would also satisfy the session middleware and could mask
 * bearer-path bugs. Always paired with a try/finally that closes the context. */
async function withBearerOnlyContext(browser: Browser, fn: (ctx: BrowserContext) => Promise<void>): Promise<void> {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
        await fn(ctx);
    } finally {
        await ctx.close();
    }
}

test.describe('public /v1 API', () => {
    test('mint → POST → GET → complete → SSE → revoke roundtrip', async ({ browser }) => {
        const email = `public-api-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            // 1. Mint a token via the page's session-cookie context.
            const { id: tokenId, plaintext } = await mintTokenViaSession(page.context().request, 'e2e');

            // 2. Open a fresh bearer-only context (no cookies) so /v1 calls exercise the bearer auth path.
            await withBearerOnlyContext(browser, async (apiContext) => {
                const auth = { headers: { Authorization: `Bearer ${plaintext}` } };

                // 3. POST /v1/items — capture an inbox item with externalId.
                const created = await apiContext.request.post(`${API_URL}/v1/items`, {
                    headers: auth.headers,
                    data: { title: 'Hello from /v1', externalId: 'e2e-1' },
                });
                expect(created.status()).toBe(201);
                const createdBody = (await created.json()) as { _id: string; status: string; title: string; externalId?: string };
                expect(createdBody.status).toBe('inbox');
                expect(createdBody.title).toBe('Hello from /v1');
                expect(createdBody.externalId).toBe('e2e-1');

                // 4. POST /v1/items again with same externalId — idempotent replay.
                const replay = await apiContext.request.post(`${API_URL}/v1/items`, {
                    headers: auth.headers,
                    data: { title: 'Hello from /v1', externalId: 'e2e-1' },
                });
                expect(replay.status()).toBe(201);
                expect(replay.headers()['x-idempotent-replay']).toBe('true');
                const replayBody = (await replay.json()) as { _id: string };
                expect(replayBody._id).toBe(createdBody._id);

                // 5. GET /v1/items?status=inbox — list shows the new item.
                const list = await apiContext.request.get(`${API_URL}/v1/items?status=inbox`, { headers: auth.headers });
                expect(list.status()).toBe(200);
                const listBody = (await list.json()) as { items: Array<{ _id: string }> };
                expect(listBody.items.some((i) => i._id === createdBody._id)).toBe(true);

                // 6. GET /v1/items/:id — single fetch.
                const single = await apiContext.request.get(`${API_URL}/v1/items/${createdBody._id}`, { headers: auth.headers });
                expect(single.status()).toBe(200);

                // 7. CRITICAL assertion: the public-API write fan-out actually pushes through SSE.
                //
                // Two checks in series so we can distinguish "SSE fired" from "any sync path eventually
                // caught up". A pure IDB-poll would silently pass even if SSE was broken — bootstrap or
                // an opportunistic pull (online event, focus) would deliver the item independently.
                //
                // a) Wait for an SSE 'update' message to arrive in the page's console. The client logs
                //    `[debug-gcal-sync][client] sse onmessage` with `{ data: { type: 'update', ... } }`
                //    in `client/src/db/sseClient.ts:71`. Catching that line is the proof that the SSE
                //    leg of `notifyChange` actually ran.
                // b) Then assert the item lands in IDB — proves the SSE-triggered `syncAndRefresh()`
                //    completed end-to-end.
                const sseUpdatePromise = page.waitForEvent('console', {
                    predicate: (msg) => {
                        if (!msg.text().includes('sse onmessage')) return false;
                        // Inspect the args to find the {data:{type:'update'}} payload — the shape is
                        // `('[debug...] sse onmessage', { userId, data: { type: 'update' } })`.
                        const args = msg.args();
                        return args.length >= 2;
                    },
                    timeout: 10_000,
                });
                // The earlier POST (step 3) already fired its SSE message before `waitForEvent` was
                // registered, so we trigger one fresh fan-out now and wait on it. `waitForEvent` only
                // catches events from the moment it was called.
                const sseTrigger = await apiContext.request.post(`${API_URL}/v1/items`, {
                    headers: auth.headers,
                    data: { title: 'SSE trigger', externalId: 'sse-trigger-1' },
                });
                expect(sseTrigger.status()).toBe(201);
                await sseUpdatePromise;

                // Now assert IDB caught up — this is the end-to-end pipeline assertion.
                await page.evaluate(
                    async (ids) => {
                        type Harness = { listItems(): Promise<Array<{ _id: string }>> };
                        const harness = (window as unknown as { __gtd: Harness }).__gtd;
                        const deadline = Date.now() + 10_000;
                        while (Date.now() < deadline) {
                            const items = await harness.listItems();
                            const itemIds = new Set(items.map((i) => i._id));
                            if (ids.every((id) => itemIds.has(id))) return true;
                            await new Promise((r) => setTimeout(r, 200));
                        }
                        const items = await harness.listItems();
                        throw new Error(
                            `Public-API created items did not arrive on logged-in tab via SSE within 10s. expected=${JSON.stringify(ids)} ` +
                                `gotIds=${JSON.stringify(items.map((i) => i._id))}`,
                        );
                    },
                    [createdBody._id, (await sseTrigger.json())._id],
                );

                // 8. POST /v1/items/:id/complete — transitions to done.
                const completed = await apiContext.request.post(`${API_URL}/v1/items/${createdBody._id}/complete`, {
                    headers: auth.headers,
                });
                expect(completed.status()).toBe(200);
                const completedBody = (await completed.json()) as { _id: string; status: string };
                expect(completedBody.status).toBe('done');

                // 9. Re-complete: idempotent replay header.
                const reComplete = await apiContext.request.post(`${API_URL}/v1/items/${createdBody._id}/complete`, {
                    headers: auth.headers,
                });
                expect(reComplete.status()).toBe(200);
                expect(reComplete.headers()['x-idempotent-replay']).toBe('true');

                // 10. Revoke the token via the page's session — subsequent calls return 401.
                const del = await page.context().request.delete(`${API_URL}/account/tokens/${tokenId}`);
                expect(del.status()).toBe(200);

                const after = await apiContext.request.get(`${API_URL}/v1/items`, { headers: auth.headers });
                expect(after.status()).toBe(401);
            });
        });
    });

    test('content-hash dedupe collapses unkeyed duplicates within 24h window', async ({ browser }) => {
        const email = `content-dedupe-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            const { plaintext } = await mintTokenViaSession(page.context().request, 'dedupe');
            await withBearerOnlyContext(browser, async (apiContext) => {
                const auth = { Authorization: `Bearer ${plaintext}` };
                const sameContentRequest = { headers: auth, data: { title: 'Duplicate', notes: 'same notes' } };
                const first = await apiContext.request.post(`${API_URL}/v1/items`, sameContentRequest);
                const second = await apiContext.request.post(`${API_URL}/v1/items`, sameContentRequest);
                expect(first.status()).toBe(201);
                expect(second.status()).toBe(201);
                const firstId = (await first.json())._id;
                const secondId = (await second.json())._id;
                expect(firstId).toBe(secondId);
                expect(second.headers()['x-idempotent-replay']).toBe('true');

                // Different content → distinct id.
                const differentContent = await apiContext.request.post(`${API_URL}/v1/items`, {
                    headers: auth,
                    data: { title: 'Duplicate', notes: 'different notes' },
                });
                expect(differentContent.status()).toBe(201);
                expect((await differentContent.json())._id).not.toBe(firstId);
            });
        });
    });

    test('PATCH clarifies an inbox item; capture-only token gets 403 forbidden_scope', async ({ browser }) => {
        const email = `patch-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            const session = page.context().request;
            // Mint two tokens with different scope sets.
            const captureOnly = await session.post(`${API_URL}/account/tokens`, { data: { label: 'capture', scopes: ['items.capture', 'items.read'] } });
            const writerToken = await session.post(`${API_URL}/account/tokens`, {
                data: { label: 'writer', scopes: ['items.capture', 'items.read', 'items.write'] },
            });
            const { plaintext: capturePlaintext } = (await captureOnly.json()) as { plaintext: string };
            const { plaintext: writerPlaintext } = (await writerToken.json()) as { plaintext: string };

            await withBearerOnlyContext(browser, async (apiContext) => {
                // Create with the writer token so we have an inbox item to patch.
                const created = await apiContext.request.post(`${API_URL}/v1/items`, {
                    headers: { Authorization: `Bearer ${writerPlaintext}` },
                    data: { title: 'Patch me', externalId: 'patch-1' },
                });
                const { _id } = (await created.json()) as { _id: string };

                // Capture-only token cannot PATCH.
                const forbidden = await apiContext.request.patch(`${API_URL}/v1/items/${_id}`, {
                    headers: { Authorization: `Bearer ${capturePlaintext}` },
                    data: { status: 'nextAction' },
                });
                expect(forbidden.status()).toBe(403);
                expect(((await forbidden.json()) as { code: string }).code).toBe('forbidden_scope');

                // Writer token succeeds and the metadata round-trips.
                const ok = await apiContext.request.patch(`${API_URL}/v1/items/${_id}`, {
                    headers: { Authorization: `Bearer ${writerPlaintext}` },
                    data: { status: 'nextAction', energy: 'high', urgent: true },
                });
                expect(ok.status()).toBe(200);
                const body = (await ok.json()) as { status: string; energy: string; urgent: boolean };
                expect(body.status).toBe('nextAction');
                expect(body.energy).toBe('high');
                expect(body.urgent).toBe(true);
            });
        });
    });

    test('bulk import creates many items in one call and is idempotent on re-run', async ({ browser }) => {
        const email = `bulk-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            const { plaintext } = await mintTokenViaSession(page.context().request, 'bulk');
            await withBearerOnlyContext(browser, async (apiContext) => {
                const auth = { Authorization: `Bearer ${plaintext}` };
                const items = Array.from({ length: 50 }, (_, i) => ({ title: `Bulk ${i}`, externalId: `bulk-${i}` }));

                const first = await apiContext.request.post(`${API_URL}/v1/items/bulk`, { headers: auth, data: { items } });
                expect(first.status()).toBe(200);
                const firstBody = (await first.json()) as { counts: { created: number; replayed: number; failed: number } };
                expect(firstBody.counts).toEqual({ created: 50, replayed: 0, failed: 0 });

                // Re-import — every row should now report `replayed`.
                const second = await apiContext.request.post(`${API_URL}/v1/items/bulk`, { headers: auth, data: { items } });
                const secondBody = (await second.json()) as { counts: { created: number; replayed: number; failed: number } };
                expect(secondBody.counts).toEqual({ created: 0, replayed: 50, failed: 0 });
            });
        });
    });

    test('revoked token returns 401; new token from the same user works', async ({ browser }) => {
        const email = `revoke-and-remint-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            const session = page.context().request;
            const first = await mintTokenViaSession(session, 'first');
            await session.delete(`${API_URL}/account/tokens/${first.id}`);

            await withBearerOnlyContext(browser, async (apiContext) => {
                const revoked = await apiContext.request.get(`${API_URL}/v1/items`, { headers: { Authorization: `Bearer ${first.plaintext}` } });
                expect(revoked.status()).toBe(401);

                // New token from the same account immediately works.
                const second = await mintTokenViaSession(session, 'second');
                const works = await apiContext.request.get(`${API_URL}/v1/items`, { headers: { Authorization: `Bearer ${second.plaintext}` } });
                expect(works.status()).toBe(200);
            });
        });
    });
});
