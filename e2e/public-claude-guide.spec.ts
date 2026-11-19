import { expect, test } from '@playwright/test';
import { CLAUDE_GUIDE_EXAMPLES, CLAUDE_GUIDE_TITLE } from '../client/src/lib/claudeGuideContent';
import { closeContextQuietly } from './helpers/context';
import { API_URL, CLIENT_URL } from './helpers/env';

// /claude is the connector's public documentation — the URL Anthropic's connector directory lists.
// Contexts are fresh (no IndexedDB account, no cookie), so a regression that put the page behind the
// auth guard, which redirects to /login, fails here.

test.describe('Claude connector guide', () => {
    test('renders for a signed-out visitor with the connector URL, examples and troubleshooting', async ({ browser }) => {
        const ctx = await browser.newContext();
        try {
            const page = await ctx.newPage();
            await page.goto(`${CLIENT_URL}/claude`);
            await expect(page).toHaveURL(/\/claude$/);
            await expect(page).toHaveTitle(/Use with Claude/);
            await expect(page.getByTestId('claudeGuideTitle')).toHaveText(CLAUDE_GUIDE_TITLE);
            await expect(page.getByTestId('mcpConnectorUrl')).toHaveText(`${API_URL}/mcp`);
            await expect(page.getByTestId('claudeGuideExamples').locator('dt')).toHaveCount(CLAUDE_GUIDE_EXAMPLES.length);
            await expect(page.getByRole('heading', { level: 2, name: 'Troubleshooting' })).toBeVisible();
            await expect(page.getByTestId('claudeGuideContactLink')).toHaveAttribute('href', /^mailto:/);
        } finally {
            await closeContextQuietly(ctx);
        }
    });

    test('is reachable from the landing page and links on to the privacy policy', async ({ browser }) => {
        const ctx = await browser.newContext();
        try {
            const page = await ctx.newPage();
            await page.goto(CLIENT_URL);
            await page.getByTestId('landingClaudeGuideLink').click();
            await expect(page).toHaveURL(/\/claude$/);
            await page.getByRole('navigation', { name: 'Site pages' }).getByRole('link', { name: 'Privacy Policy' }).click();
            await expect(page).toHaveURL(/\/privacy$/);
            await expect(page.getByTestId('legalTitle')).toHaveText('Privacy Policy');
        } finally {
            await closeContextQuietly(ctx);
        }
    });
});
