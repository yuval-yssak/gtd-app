import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { closeContextQuietly, withOneLoggedInDevice } from './helpers/context';

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
            // The sign-in card keeps a one-line description (the public homepage is / — see
            // public-landing.spec.ts) so it never reads as a bare credentials prompt.
            await expect(page.getByTestId('loginAppDescription')).toContainText('personal productivity app');
            await expect(page.getByTestId('loginPrivacyLink')).toHaveAttribute('href', '/privacy');
            await page.getByTestId('loginTermsLink').click();
            await expect(page).toHaveURL(/\/terms$/);
            await expect(page.getByTestId('legalTitle')).toHaveText('Terms of Service');
            await page.getByRole('navigation', { name: 'Legal pages' }).getByRole('link', { name: 'Sign in' }).click();
            await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
            // The sign-in card links back to the public homepage.
            await page.getByTestId('loginHomeLink').click();
            await expect(page).toHaveURL(`${CLIENT_URL}/`);
            await expect(page.getByTestId('landingPage')).toBeVisible();
        } finally {
            await closeContextQuietly(ctx);
        }
    });
});

// The product name on the sign-in card, the browser tab and the app bar must match the Google OAuth
// consent screen ("Done") — reviewers compare them — and must not be the trademarked "Getting
// Things Done" / "GTD".
test.describe('product name', () => {
    test('the sign-in screen and the tab title carry the product name, and the terms name the trademark holder', async ({ browser }) => {
        const ctx = await browser.newContext();
        try {
            const page = await ctx.newPage();
            await page.goto(`${CLIENT_URL}/login`);
            await expect(page).toHaveTitle('Done');
            await expect(page.getByRole('heading', { name: 'Done', exact: true })).toBeVisible();
            await expect(page.getByRole('heading', { name: 'Getting Things Done' })).toHaveCount(0);
            await page.getByTestId('loginTermsLink').click();
            await expect(page.getByRole('heading', { level: 2, name: 'Trademarks' })).toBeVisible();
            await expect(page.getByText('The Service is called "Done"')).toBeVisible();
        } finally {
            await closeContextQuietly(ctx);
        }
    });
});

test.describe('product name inside the app', () => {
    test('the app bar, the manifest and the Settings About line carry the product name', async ({ browser }) => {
        const email = `product-name-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            // The brand is rendered up to three times (desktop drawer, keep-mounted mobile drawer, mobile
            // app bar); at least one is visible and none may carry the old name.
            const brands = page.getByTestId('appBrand');
            await expect(
                brands
                    .filter({ visible: true })
                    .filter({ hasText: /^Done$/ })
                    .first(),
            ).toBeVisible();
            await expect(brands.filter({ hasNotText: /^Done$/ })).toHaveCount(0);
            await expect(page.getByText('GTD', { exact: true })).toHaveCount(0);
            // The installed-PWA name comes from the served manifest, not the page.
            const manifest = await page.request.get(`${CLIENT_URL}/manifest.webmanifest`);
            expect(await manifest.json()).toMatchObject({ name: 'Done', short_name: 'Done' });
            await page.goto(`${CLIENT_URL}/settings`);
            await expect(page.getByText(/^Done — an offline-first productivity app built around the GTD method\.$/)).toBeVisible();
        });
    });
});

test.describe('legal pages from inside the app', () => {
    test('a signed-in user reaches both documents from the Settings App card', async ({ browser }) => {
        const email = `settings-legal-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(`${CLIENT_URL}/settings`);
            await expect(page.getByTestId('settingsTermsLink')).toHaveAttribute('href', '/terms');
            await page.getByTestId('settingsPrivacyLink').click();
            await expect(page).toHaveURL(/\/privacy$/);
            await expect(page.getByTestId('legalTitle')).toHaveText('Privacy Policy');
            // The way back must not need the API (an installed PWA has no back button): every
            // request to the server is aborted before the Home link is clicked.
            await page.context().route('http://localhost:4000/**', (route) => route.abort());
            await page.getByRole('navigation', { name: 'Legal pages' }).getByRole('link', { name: 'Home' }).click();
            await expect(page).toHaveURL(/\/inbox$/);
        });
    });
});
