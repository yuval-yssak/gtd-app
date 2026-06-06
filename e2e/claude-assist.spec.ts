import { type APIRequestContext, type Browser, type BrowserContext, expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withOneLoggedInDevice } from './helpers/context';

const API_URL = 'http://localhost:4000';

/**
 * End-to-end coverage for the Lane A Claude-assist surface (`/v1/claude/assist[/apply]`, issue #21).
 *
 * The agent loop itself calls the Anthropic API, which is NOT available in CI — so the deep
 * behaviour (tool loop, proposal shape, executeToken edit/target rules, calendar gating, metering)
 * is exhaustively unit-tested in `api-server/src/tests/v1ClaudeAssist.test.ts` with the SDK mocked.
 *
 * This spec exists so a DEPLOY regression on routing / CORS / middleware / scope-gating fails
 * loudly. It therefore drives only the guard paths that return BEFORE any model call:
 *   - scope gate (403 forbidden_scope) when the token lacks `claude.assist`
 *   - ownership guard (404 not_found) for a non-owned / non-existent item
 *   - request validation (400) on both endpoints
 *   - the executeToken verifier rejecting a malformed token (400 invalid_execute_token)
 * None of these reach the Anthropic API, so the spec is deterministic without a key.
 */

interface Minted {
    id: string;
    plaintext: string;
}

async function mintToken(request: APIRequestContext, label: string, scopes: string[]): Promise<Minted> {
    const res = await request.post(`${API_URL}/account/tokens`, { data: { label, scopes } });
    expect(res.status()).toBe(200);
    return (await res.json()) as Minted;
}

/** Fresh context with no cookies so /v1 calls exercise the bearer-only auth path. */
async function withBearerOnlyContext(browser: Browser, fn: (ctx: BrowserContext) => Promise<void>): Promise<void> {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
        await fn(ctx);
    } finally {
        await ctx.close();
    }
}

test.describe('Lane A Claude-assist guard paths (/v1/claude/assist)', () => {
    test('scope gate, ownership guard, and request validation all reject before any model call', async ({ browser }) => {
        const email = `claude-assist-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            // A capture+read token (no claude.assist) and a full token that DOES carry claude.assist.
            const noAssist = await mintToken(page.context().request, 'no-assist', ['items.capture', 'items.read']);
            const withAssist = await mintToken(page.context().request, 'with-assist', ['items.capture', 'items.read', 'claude.assist']);

            // Seed an inbox item the assist token's user owns.
            const created = await page.context().request.post(`${API_URL}/v1/items`, {
                headers: { Authorization: `Bearer ${withAssist.plaintext}` },
                data: { title: 'clarify me', externalId: `claude-e2e-${dayjs().valueOf()}` },
            });
            expect(created.status()).toBe(201);
            const itemId = ((await created.json()) as { _id: string })._id;

            await withBearerOnlyContext(browser, async (api) => {
                const assistUrl = `${API_URL}/v1/claude/assist`;
                const applyUrl = `${API_URL}/v1/claude/assist/apply`;

                // 1. Missing claude.assist scope → 403 forbidden_scope (never reaches the model).
                const noScope = await api.request.post(assistUrl, {
                    headers: { Authorization: `Bearer ${noAssist.plaintext}` },
                    data: { itemId },
                });
                expect(noScope.status()).toBe(403);
                expect((await noScope.json()) as { code: string }).toMatchObject({ code: 'forbidden_scope' });

                // 2. Missing itemId → 400 invalid_request.
                const noItem = await api.request.post(assistUrl, {
                    headers: { Authorization: `Bearer ${withAssist.plaintext}` },
                    data: {},
                });
                expect(noItem.status()).toBe(400);
                expect((await noItem.json()) as { code: string }).toMatchObject({ code: 'invalid_request' });

                // 3. Non-existent / non-owned item → 404 not_found (no existence leak).
                const notOwned = await api.request.post(assistUrl, {
                    headers: { Authorization: `Bearer ${withAssist.plaintext}` },
                    data: { itemId: 'does-not-exist' },
                });
                expect(notOwned.status()).toBe(404);
                expect((await notOwned.json()) as { code: string }).toMatchObject({ code: 'not_found' });

                // 4. apply: missing token → 400 invalid_request.
                const noToken = await api.request.post(applyUrl, {
                    headers: { Authorization: `Bearer ${withAssist.plaintext}` },
                    data: { patch: { title: 'x' } },
                });
                expect(noToken.status()).toBe(400);
                expect((await noToken.json()) as { code: string }).toMatchObject({ code: 'invalid_request' });

                // 5. apply: malformed token → 400 invalid_execute_token (verifier rejects, no write).
                const badToken = await api.request.post(applyUrl, {
                    headers: { Authorization: `Bearer ${withAssist.plaintext}` },
                    data: { executeToken: 'not.a.valid.token', patch: { title: 'x' } },
                });
                expect(badToken.status()).toBe(400);
                expect((await badToken.json()) as { code: string }).toMatchObject({ code: 'invalid_execute_token' });
            });

            // Dual-auth (Phase 1): the first-party COOKIE SESSION reaches the assist route with NO
            // Authorization header. A missing itemId returns 400 invalid_request — which only happens
            // AFTER authenticateBearerOrSession resolves the session, so this proves the cookie path
            // (and the credentialed assistCors) works at the deploy level without reaching the model.
            const sessionAssist = await page.request.post(`${API_URL}/v1/claude/assist`, { data: {} });
            expect(sessionAssist.status()).toBe(400);
            expect((await sessionAssist.json()) as { code: string }).toMatchObject({ code: 'invalid_request' });
        });
    });
});
