import { createHash } from 'node:crypto';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withOneLoggedInDevice } from './helpers/context';
import { API_URL, CLIENT_URL } from './helpers/env';
import { uniqueStamp } from './helpers/uniqueStamp';

// Cover the user-visible flow end-to-end: navigate to settings, mint a token, observe the
// one-shot reveal, copy plaintext, revoke from the list, and verify the row stays visible
// in dimmed/revoked form. The /v1 round-trip with the minted token is covered separately
// by `public-api.spec.ts` (issue #19 step 2) — keeping that out of this spec keeps the
// settings-UI assertions tight and the spec fast.

// Derived rather than hard-coded so the pair can never drift apart and fail the code exchange.
const PKCE_VERIFIER = 'e2e-pkce-verifier-that-is-at-least-forty-three-characters';
const PKCE_CHALLENGE = createHash('sha256').update(PKCE_VERIFIER).digest('base64url');
// Nothing listens here: the spec reads the code off the decision response and never follows the redirect.
const OAUTH_REDIRECT_URI = 'http://127.0.0.1:65530/callback';

async function registerOAuthClient(request: APIRequestContext) {
    const registration = await request.post(`${API_URL}/mcp-oauth/register`, { data: { redirect_uris: [OAUTH_REDIRECT_URI], client_name: 'Claude' } });
    expect(registration.status()).toBe(201);
    return ((await registration.json()) as { client_id: string }).client_id;
}

/**
 * Walks the consent page as a person would and returns the authorization code from the redirect.
 * The decision POST is answered from its own `Location` header instead of being followed: Playwright
 * does not route the target of a redirected navigation, so the tab would hit the dead loopback URI.
 */
async function approveConsent(page: Page, clientId: string) {
    const authorize = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: OAUTH_REDIRECT_URI,
        code_challenge: PKCE_CHALLENGE,
        code_challenge_method: 'S256',
        scope: 'items.read',
        state: 'e2e',
    });
    const redirectLocation = new Promise<string>((resolve) => {
        void page.route(`${API_URL}/mcp-oauth/authorize/decision`, async (route) => {
            const response = await route.fetch({ maxRedirects: 0 });
            resolve(response.headers().location ?? '');
            await route.fulfill({ status: 200, body: 'consented' });
        });
    });
    await page.goto(`${API_URL}/mcp-oauth/authorize?${authorize}`);
    await page.getByRole('button', { name: 'Allow' }).click();
    const code = new URL(await redirectLocation).searchParams.get('code');
    if (!code) {
        throw new Error('consent redirect carried no code');
    }
    return code;
}

async function postTokenGrant(request: APIRequestContext, form: Record<string, string>) {
    const res = await request.post(`${API_URL}/mcp-oauth/token`, { form });
    expect(res.status()).toBe(200);
    return ((await res.json()) as { refresh_token: string }).refresh_token;
}

/** Connects an MCP client and refreshes it twice — three hourly access tokens' worth of rows. */
async function connectMcpClientAndRefreshTwice(page: Page) {
    const clientId = await registerOAuthClient(page.request);
    const code = await approveConsent(page, clientId);
    const first = await postTokenGrant(page.request, {
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: OAUTH_REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
    });
    const second = await postTokenGrant(page.request, { grant_type: 'refresh_token', refresh_token: first, client_id: clientId });
    await postTokenGrant(page.request, { grant_type: 'refresh_token', refresh_token: second, client_id: clientId });
}

test.describe('Personal API tokens (settings)', () => {
    test('a connected Claude client and its hourly refreshes never show up as personal tokens', async ({ browser }) => {
        const email = `tokens-oauth-${uniqueStamp()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            await connectMcpClientAndRefreshTwice(page);

            await page.goto(`${CLIENT_URL}/settings`);

            await expect(page.getByTestId('tokensEmptyState')).toBeVisible();
            await expect(page.getByTestId('tokenRow')).toHaveCount(0);
        });
    });

    test('mint, reveal, revoke', async ({ browser }) => {
        const email = `tokens-${uniqueStamp()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(`${CLIENT_URL}/settings`);

            // Empty state shows the "Create token" CTA on first visit.
            await expect(page.getByTestId('tokensEmptyState')).toBeVisible();

            await page.getByTestId('createTokenButton').click();
            await page.getByTestId('tokenLabelInput').locator('input').fill('Local MCP');
            // Tick items.write so the resulting row exposes three scope chips. (items.capture +
            // items.read are pre-checked from DEFAULT_NEW_TOKEN_SCOPES.)
            await page.getByTestId('scopeCheckbox-items.write').getByRole('checkbox').check();
            await page.getByTestId('confirmCreateTokenButton').click();

            // Reveal dialog shows the plaintext exactly once. The plaintext starts with `gtd_` per
            // `apiTokens.ts:6`; we only assert the prefix to avoid coupling to the random tail length.
            const reveal = page.getByTestId('tokenRevealDialog');
            await expect(reveal).toBeVisible();
            const plaintext = (await page.getByTestId('tokenPlaintext').textContent()) ?? '';
            expect(plaintext.startsWith('gtd_')).toBe(true);
            expect(plaintext.length).toBeGreaterThan(20);

            await page.getByTestId('dismissRevealButton').click();
            await expect(reveal).toBeHidden();

            // List now shows the row with label, "Never used", and the three scope chips.
            const row = page.getByTestId('tokenRow');
            await expect(row).toHaveCount(1);
            await expect(row).toContainText('Local MCP');
            await expect(row).toContainText('Never used');
            await expect(row.getByTestId('tokenScopeChip')).toHaveCount(3);

            // Revoke flow.
            await page.getByTestId('revokeTokenButton').click();
            await page.getByTestId('confirmRevokeTokenButton').click();

            // After revoke, the row stays visible (so users can see what they revoked) but the
            // Revoke button is gone and the secondary text shows the revoke date.
            await expect(row).toContainText('Local MCP');
            await expect(row).toContainText('Revoked');
            await expect(page.getByTestId('revokeTokenButton')).toHaveCount(0);
        });
    });

    test('label is required; create button surfaces the validation error inline', async ({ browser }) => {
        const email = `label-required-${uniqueStamp()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(`${CLIENT_URL}/settings`);
            await page.getByTestId('createTokenButton').click();
            // Submit with the label blank — must surface inline validation, not call the server.
            await page.getByTestId('confirmCreateTokenButton').click();
            await expect(page.getByTestId('createTokenDialog')).toBeVisible();
            // MUI helperText renders inside the TextField wrapper; use the dialog as the scope.
            await expect(page.getByTestId('createTokenDialog')).toContainText('Label is required');
            await expect(page.getByTestId('tokenRevealDialog')).toHaveCount(0);
        });
    });

    test('copy-to-clipboard failure surfaces an inline error and keeps the reveal dialog open', async ({ browser }) => {
        const email = `copy-fail-${uniqueStamp()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(`${CLIENT_URL}/settings`);

            // Force navigator.clipboard.writeText to reject so the failure path runs.
            // Using addInitScript would be too early (runs before SPA mount); evaluate after navigation
            // is more direct here.
            await page.evaluate(() => {
                Object.defineProperty(navigator, 'clipboard', {
                    configurable: true,
                    value: { writeText: () => Promise.reject(new Error('Permission denied')) },
                });
            });

            await page.getByTestId('createTokenButton').click();
            await page.getByTestId('tokenLabelInput').locator('input').fill('Copy fail');
            await page.getByTestId('confirmCreateTokenButton').click();

            const reveal = page.getByTestId('tokenRevealDialog');
            await expect(reveal).toBeVisible();

            await page.getByTestId('copyTokenButton').click();
            await expect(page.getByTestId('copyTokenError')).toContainText('Permission denied');
            // Reveal dialog must remain open so the user can still copy the token manually.
            await expect(reveal).toBeVisible();
        });
    });

    test('renders an "unused" chip on tokens that have never been used or are older than 90 days', async ({ browser }) => {
        const email = `unused-chip-${uniqueStamp()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(`${CLIENT_URL}/settings`);

            // 1. Mint two tokens.
            await page.getByTestId('createTokenButton').click();
            await page.getByTestId('tokenLabelInput').locator('input').fill('Stale token');
            await page.getByTestId('confirmCreateTokenButton').click();
            await page.getByTestId('dismissRevealButton').click();

            await page.getByTestId('createTokenButton').click();
            await page.getByTestId('tokenLabelInput').locator('input').fill('Fresh token');
            await page.getByTestId('confirmCreateTokenButton').click();
            await page.getByTestId('dismissRevealButton').click();

            // Both tokens have lastUsedTs unset → both show "unused".
            await expect(page.getByTestId('unusedTokenChip')).toHaveCount(2);

            // 2. Look up the stale token's id from the list endpoint, then push lastUsedTs back 100 days.
            const listRes = await page.context().request.get(`${API_URL}/account/tokens`);
            const { tokens } = (await listRes.json()) as { tokens: Array<{ id: string; label: string }> };
            const staleId = tokens.find((t) => t.label === 'Stale token')?.id;
            const freshId = tokens.find((t) => t.label === 'Fresh token')?.id;
            expect(staleId).toBeTruthy();
            expect(freshId).toBeTruthy();

            const oldTs = dayjs().subtract(100, 'day').toISOString();
            const recentTs = dayjs().subtract(1, 'day').toISOString();
            const stalePoke = await page.context().request.post(`${API_URL}/dev/api-tokens/${staleId}/touch`, { data: { lastUsedTs: oldTs } });
            expect(stalePoke.status()).toBe(200);
            const freshPoke = await page.context().request.post(`${API_URL}/dev/api-tokens/${freshId}/touch`, { data: { lastUsedTs: recentTs } });
            expect(freshPoke.status()).toBe(200);

            await page.reload();
            // Stale shows the chip; fresh does not.
            const chip = page.getByTestId('unusedTokenChip');
            await expect(chip).toHaveCount(1);
            // Confirm the chip is on the right row by walking up to the row's primary text.
            const staleRow = page.getByTestId('tokenRow').filter({ hasText: 'Stale token' });
            await expect(staleRow.getByTestId('unusedTokenChip')).toBeVisible();
            const freshRow = page.getByTestId('tokenRow').filter({ hasText: 'Fresh token' });
            await expect(freshRow.getByTestId('unusedTokenChip')).toHaveCount(0);
        });
    });

    test('mints a reassign.accept token and renders it as a scope chip on the row', async ({ browser }) => {
        const email = `reassign-accept-${uniqueStamp()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(`${CLIENT_URL}/settings`);

            await page.getByTestId('createTokenButton').click();
            await page.getByTestId('tokenLabelInput').locator('input').fill('Recipient');
            // Tick the new reassign.accept scope so the resulting token authorises another
            // account's `reassign`-scoped token to push items into this account.
            await page.getByTestId('scopeCheckbox-reassign.accept').getByRole('checkbox').check();
            await page.getByTestId('confirmCreateTokenButton').click();
            await page.getByTestId('dismissRevealButton').click();

            const row = page.getByTestId('tokenRow');
            await expect(row).toContainText('Recipient');
            // items.capture + items.read default scopes plus the new reassign.accept = 3 chips.
            await expect(row.getByTestId('tokenScopeChip')).toHaveCount(3);
            // Tightened from a substring `toContainText` to a literal-bounded chip filter so a
            // future relabel can't sneak past — and so neither chip shadows the other (the
            // substring "reassign" appears inside "reassign.accept", which made the old
            // toContainText assertion satisfiable by either chip alone).
            await expect(row.getByTestId('tokenScopeChip').filter({ hasText: /^reassign\.accept$/ })).toHaveCount(1);
            await expect(row.getByTestId('tokenScopeChip').filter({ hasText: /^reassign$/ })).toHaveCount(0);
        });
    });

    test('reveal dialog cannot be dismissed by Escape or backdrop click', async ({ browser }) => {
        const email = `reveal-pin-${uniqueStamp()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(`${CLIENT_URL}/settings`);
            await page.getByTestId('createTokenButton').click();
            await page.getByTestId('tokenLabelInput').locator('input').fill('Pin test');
            await page.getByTestId('confirmCreateTokenButton').click();

            const reveal = page.getByTestId('tokenRevealDialog');
            await expect(reveal).toBeVisible();

            // Escape should NOT dismiss — disableEscapeKeyDown is set on the reveal dialog.
            await page.keyboard.press('Escape');
            await expect(reveal).toBeVisible();

            // Backdrop click should also NOT dismiss — the onClose handler ignores 'backdropClick'.
            // MUI's backdrop sits behind the modal and the safest cross-browser way to click it is
            // through the page's body at coordinate (1, 1), which lands outside the dialog content.
            await page.mouse.click(1, 1);
            await expect(reveal).toBeVisible();

            await page.getByTestId('dismissRevealButton').click();
            await expect(reveal).toBeHidden();
        });
    });
});
