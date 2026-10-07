import { type Browser, expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withOneLoggedInDevice } from './helpers/context';

const CLIENT_URL = 'http://localhost:4173';
// RFC 7636 appendix B challenge — any well-formed S256 value lets /authorize render; no token is redeemed here.
const PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

// Settings → "Connect Claude" is the self-serve guide to the hosted MCP endpoint. The spec proves
// the URL it shows is a live MCP resource whose OAuth discovery chain an MCP client can follow, that
// the Authorize page the guide describes really shows the account and a way to switch it, and that
// the copy buttons hand over exact text with visible confirmation.

const claudeCodeCommand = (connectorUrl: string) => `claude mcp add --scope user --transport http done ${connectorUrl}`;

/** Fresh user, signed in, on /settings with the Connect Claude section rendered. */
async function withSettingsPage(
    browser: Browser,
    emailPrefix: string,
    fn: (page: Page, email: string) => Promise<void>,
    contextOptions?: Parameters<Browser['newContext']>[0],
) {
    const email = `${emailPrefix}-${dayjs().valueOf()}@example.com`;
    await resetServerForEmails([email]);
    await withOneLoggedInDevice(
        browser,
        email,
        async (page) => {
            await page.goto(`${CLIENT_URL}/settings`);
            await expect(page.getByTestId('connectClaudeSection')).toBeVisible();
            await fn(page, email);
        },
        contextOptions,
    );
}

async function shownConnectorUrl(page: Page) {
    const connectorUrl = (await page.getByTestId('mcpConnectorUrl').textContent()) ?? '';
    // Guards every later equality check against passing on an empty string.
    expect(connectorUrl).toMatch(/^https?:\/\/.+\/mcp$/);
    return connectorUrl;
}

test.describe('Connect Claude (settings)', () => {
    test('shows a connector URL whose OAuth discovery chain an MCP client can follow', async ({ browser, request }) => {
        await withSettingsPage(browser, 'connect-claude', async (page) => {
            const connectorUrl = await shownConnectorUrl(page);
            await expect(page.getByTestId('claudeCodeAddCommand')).toHaveText(claudeCodeCommand(connectorUrl));

            // An unauthenticated call is what kicks off sign-in in Claude: a 401 whose
            // WWW-Authenticate names the protected-resource metadata for this exact URL.
            const unauthenticated = await request.post(connectorUrl, { data: {} });
            expect(unauthenticated.status()).toBe(401);
            const challenge = unauthenticated.headers()['www-authenticate'] ?? '';
            const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
            if (!metadataUrl) throw new Error(`expected resource_metadata in WWW-Authenticate, got "${challenge}"`);

            const resource = await (await request.get(metadataUrl)).json();
            expect(resource.resource).toBe(connectorUrl);
            const [authorizationServer] = resource.authorization_servers;
            if (!authorizationServer) throw new Error('expected one authorization server');

            const server = await (await request.get(`${authorizationServer}/.well-known/oauth-authorization-server`)).json();
            expect(server.authorization_endpoint).toMatch(/\/mcp-oauth\/authorize$/);
            expect(server.code_challenge_methods_supported).toContain('S256');
        });
    });

    test('the Authorize page names the signed-in account and offers a different one', async ({ browser }) => {
        await withSettingsPage(browser, 'connect-claude-consent', async (page, email) => {
            const connectorUrl = await shownConnectorUrl(page);
            const apiOrigin = new URL(connectorUrl).origin;
            // page.request shares the browser context's cookies, i.e. the same API session Claude's browser window would carry.
            const registration = await page.request.post(`${apiOrigin}/mcp-oauth/register`, {
                data: { redirect_uris: ['http://127.0.0.1:9/callback'], client_name: 'Claude' },
            });
            expect(registration.status()).toBe(201);
            const { client_id: clientId } = await registration.json();

            const authorize = new URLSearchParams({
                response_type: 'code',
                client_id: clientId,
                redirect_uri: 'http://127.0.0.1:9/callback',
                code_challenge: PKCE_CHALLENGE,
                code_challenge_method: 'S256',
                scope: 'items.read items.write',
                state: 'e2e',
            });
            await page.goto(`${apiOrigin}/mcp-oauth/authorize?${authorize}`);

            await expect(page.getByRole('heading', { name: 'Authorize access' })).toBeVisible();
            await expect(page.locator('body')).toContainText(email);
            await expect(page.getByRole('button', { name: 'Allow' })).toBeVisible();
            const switchAccount = page.getByTestId('switchAccount');
            await expect(switchAccount.getByRole('button', { name: 'Use a different account with Google' })).toBeVisible();
            await expect(switchAccount.getByRole('button', { name: 'Use a different account with GitHub' })).toBeVisible();
        });
    });

    test('copy buttons put the URL and the Claude Code command on the clipboard and confirm it', async ({ browser }) => {
        await withSettingsPage(
            browser,
            'connect-claude-copy',
            async (page) => {
                const connectorUrl = await shownConnectorUrl(page);

                await page.getByTestId('mcpConnectorUrlCopyButton').click();
                expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(connectorUrl);
                await expect(page.getByTestId('mcpConnectorUrlCopyButtonFeedback')).toContainText('Copied connector URL');

                await page.getByTestId('claudeCodeAddCommandCopyButton').click();
                expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(claudeCodeCommand(connectorUrl));
                await expect(page.getByTestId('claudeCodeAddCommandCopyButtonFeedback')).toContainText('Copied command');
            },
            { permissions: ['clipboard-read', 'clipboard-write'] },
        );
    });

    test('a refused clipboard says so instead of failing silently', async ({ browser }) => {
        await withSettingsPage(browser, 'connect-claude-copyfail', async (page) => {
            await page.evaluate(() => {
                Object.defineProperty(navigator, 'clipboard', {
                    configurable: true,
                    value: { writeText: () => Promise.reject(new Error('Permission denied')) },
                });
            });

            await page.getByTestId('mcpConnectorUrlCopyButton').click();
            await expect(page.getByTestId('mcpConnectorUrlCopyButtonFeedback')).toContainText('Could not copy. Select text manually.');
        });
    });
});
