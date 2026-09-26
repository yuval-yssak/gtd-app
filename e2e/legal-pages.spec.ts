import { expect, test } from '@playwright/test';
import { closeContextQuietly } from './helpers/context';

const CLIENT_URL = 'http://localhost:4173';

// /privacy and /terms are public routes: Google's OAuth verification reviewers (and any visitor)
// must reach them without a session, directly by URL and from the sign-in screen. Contexts are
// fresh (no IndexedDB account, no cookie) so a regression that wrapped them in the auth guard —
// which redirects to /login — fails here.

test.describe('legal pages', () => {
    test('privacy policy renders for a signed-out visitor with its sections and the Google disclosure', async ({ browser }) => {
        const ctx = await browser.newContext();
        try {
            const page = await ctx.newPage();
            await page.goto(`${CLIENT_URL}/privacy`);
            await expect(page).toHaveURL(/\/privacy$/);
            await expect(page.getByTestId('legalTitle')).toHaveText('Privacy Policy');
            await expect(page.getByRole('heading', { level: 2, name: 'Google API Services disclosure' })).toBeVisible();
            await expect(page.getByText('including the Limited Use requirements')).toBeVisible();
            // The table of contents deep-links to the section anchors the renderer stamps.
            await page.getByRole('navigation', { name: 'Contents' }).getByRole('link', { name: 'How long we keep it' }).click();
            await expect(page).toHaveURL(/#how-long-we-keep-it$/);
            await expect(page.locator('h2#how-long-we-keep-it')).toBeInViewport();
        } finally {
            await closeContextQuietly(ctx);
        }
    });

    test('terms of service renders and cross-links to the privacy policy in the same tab', async ({ browser }) => {
        const ctx = await browser.newContext();
        try {
            const page = await ctx.newPage();
            await page.goto(`${CLIENT_URL}/terms`);
            await expect(page.getByTestId('legalTitle')).toHaveText('Terms of Service');
            await expect(page.getByRole('heading', { level: 2, name: 'Governing law' })).toBeVisible();
            // The Markdown body link (rendered by DocumentLink) must stay in this tab: a new tab would
            // leave this page's URL on /terms and add a second page to the context.
            await page.locator('[data-testid="legalPage"] p a[href="/privacy"]').click();
            await expect(page).toHaveURL(/\/privacy$/);
            expect(ctx.pages()).toHaveLength(1);
            await page.getByRole('navigation', { name: 'Legal pages' }).getByRole('link', { name: 'Terms of Service' }).click();
            await expect(page).toHaveURL(/\/terms$/);
            expect(ctx.pages()).toHaveLength(1);
        } finally {
            await closeContextQuietly(ctx);
        }
    });

    test('a deep link to a section — the form a reviewer is sent — lands on that section', async ({ browser }) => {
        const ctx = await browser.newContext();
        try {
            const page = await ctx.newPage();
            await page.goto(`${CLIENT_URL}/privacy#contact`);
            await expect(page.locator('h2#contact')).toBeInViewport();
        } finally {
            await closeContextQuietly(ctx);
        }
    });

    test('the sign-in screen links to both documents', async ({ browser }) => {
        const ctx = await browser.newContext();
        try {
            const page = await ctx.newPage();
            await page.goto(`${CLIENT_URL}/login`);
            await expect(page.getByTestId('loginPrivacyLink')).toHaveAttribute('href', '/privacy');
            await page.getByTestId('loginTermsLink').click();
            await expect(page).toHaveURL(/\/terms$/);
            await expect(page.getByTestId('legalTitle')).toHaveText('Terms of Service');
            await page.getByRole('navigation', { name: 'Legal pages' }).getByRole('link', { name: 'Sign in' }).click();
            await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
        } finally {
            await closeContextQuietly(ctx);
        }
    });
});
