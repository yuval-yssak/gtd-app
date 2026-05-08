import { type APIRequestContext, type Browser, type BrowserContext, expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withOneLoggedInDevice } from './helpers/context';

const API_URL = 'http://localhost:4000';

/**
 * Phase 4 e2e for the broadened public /v1 API. Drives a full GTD lifecycle through the
 * bearer-only path: capture → clarify (PATCH) → calendar transition → POST /complete → negative
 * (status_field_violation on PATCH `{status:'calendar', ignoreBefore}`).
 *
 * Pairs with `public-api.spec.ts` (the original mint/POST/GET roundtrip) and the dedicated
 * routines/batch specs. GCal pushback is intentionally not asserted — that lives in the
 * manually-run smoke tests under `e2e/gcal-sync-smoke/`.
 */

interface Plaintext {
    id: string;
    plaintext: string;
}

async function mintFullSurfaceToken(request: APIRequestContext): Promise<Plaintext> {
    const res = await request.post(`${API_URL}/account/tokens`, {
        data: { label: 'phase4-full-surface', scopes: ['items.capture', 'items.read', 'items.write'] },
    });
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

test.describe('public /v1 full-surface lifecycle', () => {
    test('capture → clarify nextAction → schedule calendar → complete via POST', async ({ browser }) => {
        const email = `public-api-full-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            const { plaintext } = await mintFullSurfaceToken(page.context().request);

            await withBearerOnlyContext(browser, async (apiContext) => {
                const auth = { headers: { Authorization: `Bearer ${plaintext}` } };
                const ts = dayjs().valueOf();

                // 1. Capture an inbox item.
                const capture = await apiContext.request.post(`${API_URL}/v1/items`, {
                    ...auth,
                    data: { title: 'Plan Q3 OKRs', externalId: `e2e-full-surface-${ts}` },
                });
                expect(capture.status()).toBe(201);
                const captured = (await capture.json()) as { _id: string; status: string };
                expect(captured.status).toBe('inbox');
                const id = captured._id;

                // 2. PATCH inbox → nextAction with metadata. Phase 3 broadened the surface so this
                //    accepts a full clarify in one call.
                const clarify = await apiContext.request.patch(`${API_URL}/v1/items/${id}`, {
                    ...auth,
                    data: { status: 'nextAction', energy: 'high', urgent: true, time: 90 },
                });
                expect(clarify.status()).toBe(200);
                const clarified = (await clarify.json()) as { status: string; energy: string; urgent: boolean; time: number };
                expect(clarified.status).toBe('nextAction');
                expect(clarified.energy).toBe('high');
                expect(clarified.urgent).toBe(true);
                expect(clarified.time).toBe(90);

                // 3. PATCH nextAction → calendar with timeStart/timeEnd. The broadened PATCH
                //    accepts arbitrary matrix-allowed transitions (clarify-only is gone).
                const schedule = await apiContext.request.patch(`${API_URL}/v1/items/${id}`, {
                    ...auth,
                    data: { status: 'calendar', timeStart: '2099-04-01T10:00:00Z', timeEnd: '2099-04-01T11:00:00Z' },
                });
                expect(schedule.status()).toBe(200);
                const scheduled = (await schedule.json()) as { status: string; timeStart: string; energy?: string };
                expect(scheduled.status).toBe('calendar');
                expect(scheduled.timeStart).toBe('2099-04-01T10:00:00Z');
                // sanitizeStaleFields strips fields not allowed under `calendar` (energy/urgent/time).
                expect(scheduled.energy).toBeUndefined();

                // 4. POST /complete shortcut still works after multiple transitions.
                const complete = await apiContext.request.post(`${API_URL}/v1/items/${id}/complete`, auth);
                expect(complete.status()).toBe(200);
                const done = (await complete.json()) as { status: string; timeStart?: string };
                expect(done.status).toBe('done');
                // Done is archival — the matrix preserves prior status fields, so `timeStart` is kept.
                expect(done.timeStart).toBe('2099-04-01T10:00:00Z');
            });
        });
    });

    test('PATCH { status: "calendar", ignoreBefore } returns 400 status_field_violation with extra carrying the offending cell', async ({ browser }) => {
        const email = `public-api-neg-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            const { plaintext } = await mintFullSurfaceToken(page.context().request);
            await withBearerOnlyContext(browser, async (apiContext) => {
                const auth = { headers: { Authorization: `Bearer ${plaintext}` } };
                const create = await apiContext.request.post(`${API_URL}/v1/items`, { ...auth, data: { title: 'neg' } });
                const { _id } = (await create.json()) as { _id: string };
                const res = await apiContext.request.patch(`${API_URL}/v1/items/${_id}`, {
                    ...auth,
                    data: { status: 'calendar', timeStart: '2099-04-01T10:00:00Z', timeEnd: '2099-04-01T11:00:00Z', ignoreBefore: '2099-03-15' },
                });
                expect(res.status()).toBe(400);
                const body = (await res.json()) as { code: string; extra?: { status: string; field: string } };
                expect(body.code).toBe('status_field_violation');
                expect(body.extra).toEqual({ status: 'calendar', field: 'ignoreBefore' });
            });
        });
    });

    test('PATCH { status: "trash" } is rejected with invalid_transition (in-app UI only)', async ({ browser }) => {
        const email = `public-api-trash-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            const { plaintext } = await mintFullSurfaceToken(page.context().request);
            await withBearerOnlyContext(browser, async (apiContext) => {
                const auth = { headers: { Authorization: `Bearer ${plaintext}` } };
                const create = await apiContext.request.post(`${API_URL}/v1/items`, { ...auth, data: { title: 'no-trash' } });
                const { _id } = (await create.json()) as { _id: string };
                const res = await apiContext.request.patch(`${API_URL}/v1/items/${_id}`, { ...auth, data: { status: 'trash' } });
                expect(res.status()).toBe(409);
                expect(((await res.json()) as { code: string }).code).toBe('invalid_transition');
            });
        });
    });
});
