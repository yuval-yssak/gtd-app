import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { closeContextQuietly, withOneLoggedInDevice } from './helpers/context';
import { fetchDevSessionCookie } from './helpers/login';

const CLIENT_URL = 'http://localhost:4173';

/** The four scopes the API server requests on connect (unit-pinned against calendar.ts). */
const REQUESTED_SCOPES = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.calendars.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
];

// `/` is the homepage URL in the Google OAuth branding config. Verification rejected it as
// "behind a login page" while signed-out visits redirected to /login, so a fresh context (no
// IndexedDB account, no cookie) must stay on `/` and read a description, the Google data-use
// section and the legal links — while signed-in visitors still land in the inbox.

test.describe('public homepage', () => {
    test('a signed-out visitor stays on / and can read what the app does and how it uses Google data', async ({ browser }) => {
        const ctx = await browser.newContext();
        try {
            const page = await ctx.newPage();
            await page.goto(CLIENT_URL);
            await expect(page).toHaveURL(`${CLIENT_URL}/`);
            await expect(page.getByRole('heading', { level: 1, name: 'Done', exact: true })).toBeVisible();
            await expect(page.getByTestId('landingTagline')).toContainText('built around the Getting Things Done® method by David Allen');
            await expect(page.getByTestId('landingTrademarkNotice')).toContainText('registered trademarks of the David Allen Company');
            const googleSection = page.getByTestId('landingGoogleDataUse');
            await expect(googleSection.getByRole('heading', { level: 2, name: 'How Done uses your Google data' })).toBeVisible();
            for (const scope of REQUESTED_SCOPES) {
                await expect(googleSection.getByText(scope, { exact: true })).toBeVisible();
            }
            await expect(page.getByTestId('landingLimitedUse')).toContainText('Anthropic');
            await expect(page.getByTestId('landingLimitedUse')).toContainText('never used for advertising');
            await expect(page.getByTestId('landingPrivacyLink')).toHaveAttribute('href', '/privacy');
            await expect(page.getByTestId('landingTermsLink')).toHaveAttribute('href', '/terms');
            await expect(page.getByRole('button', { name: 'Sign in with Google' })).toHaveCount(0);
        } finally {
            await closeContextQuietly(ctx);
        }
    });

    test('the sign-in button and the privacy link reach their public pages', async ({ browser }) => {
        const ctx = await browser.newContext();
        try {
            const page = await ctx.newPage();
            await page.goto(CLIENT_URL);
            await page.getByTestId('landingPrivacyLink').click();
            await expect(page).toHaveURL(/\/privacy$/);
            await expect(page.getByTestId('legalTitle')).toHaveText('Privacy Policy');
            await page.goto(CLIENT_URL);
            await page.getByTestId('landingSignIn').click();
            await expect(page).toHaveURL(/\/login$/);
            await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
        } finally {
            await closeContextQuietly(ctx);
        }
    });

    test('the Google disclosure link scrolls to that section of the privacy policy, on a phone viewport', async ({ browser }) => {
        // The link a reviewer is most likely to click; an in-app hash navigation must land on the
        // heading, not the top of the policy.
        const ctx = await browser.newContext({ viewport: { width: 400, height: 700 } });
        try {
            const page = await ctx.newPage();
            await page.goto(CLIENT_URL);
            await page.getByTestId('landingLimitedUse').getByRole('link', { name: 'Google API Services disclosure' }).click();
            await expect(page).toHaveURL(/\/privacy#google-api-services-disclosure$/);
            await expect(page.locator('h2#google-api-services-disclosure')).toBeInViewport();
        } finally {
            await closeContextQuietly(ctx);
        }
    });

    test('the served HTML describes the app without JavaScript', async ({ request }) => {
        // What an automated policy check that does not run the SPA sees.
        const response = await request.get(`${CLIENT_URL}/`);
        expect(response.ok()).toBe(true);
        const html = await response.text();
        const noscript = html.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1] ?? '';
        expect(noscript).toContain('personal productivity app');
        expect(noscript).toContain('href="/privacy"');
        expect(noscript).toContain('Google Calendar');
    });

    test('a signed-in visitor of / lands in the inbox', async ({ browser }) => {
        const email = `landing-signed-in-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(CLIENT_URL);
            await expect(page).toHaveURL(`${CLIENT_URL}/inbox`);
            await expect(page.getByTestId('landingPage')).toHaveCount(0);
        });
    });

    test('a signed-in visitor of / is redirected without any API call, from the local account alone', async ({ browser }) => {
        // PWA start_url is '/': an installed app opened with no connectivity must still reach the
        // inbox. Every API request is aborted (context offline would also block the static client
        // itself, which is served by the dev server rather than the service worker here).
        const email = `landing-no-api-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.context().route('http://localhost:4000/**', (route) => route.abort());
            await page.goto(CLIENT_URL);
            await expect(page).toHaveURL(`${CLIENT_URL}/inbox`);
        });
    });

    test('a signed-out visitor whose session check cannot reach the server still sees the homepage', async ({ browser }) => {
        // The guard used to redirect this case to /login; the homepage treats "no answer" as
        // "not signed in" and renders rather than blanking.
        const ctx = await browser.newContext();
        try {
            await ctx.route('**/auth/get-session*', (route) => route.abort());
            const page = await ctx.newPage();
            await page.goto(CLIENT_URL);
            await expect(page).toHaveURL(`${CLIENT_URL}/`);
            await expect(page.getByTestId('landingPage')).toBeVisible();
        } finally {
            await closeContextQuietly(ctx);
        }
    });

    test('a signed-out deep link into the app still lands on /login', async ({ browser }) => {
        // The guard's no-session branch was refactored to share the recovery helper.
        const ctx = await browser.newContext();
        try {
            const page = await ctx.newPage();
            await page.goto(`${CLIENT_URL}/inbox`);
            await expect(page).toHaveURL(/\/login$/);
            await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
        } finally {
            await closeContextQuietly(ctx);
        }
    });

    test('a visitor with only a server session cookie (site data cleared) is recovered into the inbox', async ({ browser }) => {
        // /login redirects such a visitor to '/'; the homepage must hydrate the account from the
        // cookie and continue to the inbox instead of showing a Sign in button that loops back.
        const email = `landing-cookie-only-${dayjs().valueOf()}@example.com`;
        const { cookie } = await fetchDevSessionCookie(email);
        const ctx = await browser.newContext();
        try {
            await ctx.addCookies([cookie]);
            const page = await ctx.newPage();
            await page.goto(CLIENT_URL);
            await expect(page).toHaveURL(`${CLIENT_URL}/inbox`);
        } finally {
            await closeContextQuietly(ctx);
        }
    });
});
