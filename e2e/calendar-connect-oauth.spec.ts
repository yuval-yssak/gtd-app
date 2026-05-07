import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';

// E2E coverage for the active-account-only Calendar Sync flow: clicking "Connect Google Calendar"
// goes straight to /calendar/auth/google?login_hint=<active.email> with no picker dialog. Also
// covers the post-OAuth mismatch error UI.
//
// We do NOT drive real Google OAuth from these tests. Instead:
//   - For the redirect path: intercept the top-level navigation to /calendar/auth/google so the
//     test can assert the URL the app would navigate to without actually leaving the page.
//   - For the mismatch UI: hit POST /dev/calendar/simulate-mismatch which performs the same
//     server-side redirect to /settings?calendarConnectError=mismatch as the real callback.

const SETTINGS_URL = 'http://localhost:4173/settings';
const DEV_SIMULATE_MISMATCH_URL = 'http://localhost:4000/dev/calendar/simulate-mismatch';

/**
 * Intercept the OAuth start request at the network layer. When the app sets
 * `window.location.href = "${API_SERVER}/calendar/auth/google?login_hint=..."`, Chromium fires a
 * top-level document request to that URL — page.route('**\/calendar\/auth\/google*') matches it.
 * We respond with an empty 200 to prevent the actual redirect to Google, and capture the URL the
 * app would have followed for the assertion.
 */
async function interceptOAuthStart(page: Page, captured: { href: string | null }): Promise<void> {
    await page.route('**/calendar/auth/google*', async (route) => {
        captured.href = route.request().url();
        await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body>intercepted</body></html>' });
    });
}

test.describe('calendar connect — active-account flow', () => {
    test('Connect button is labelled with the active account email and visible on settings', async ({ browser }) => {
        const email = `connect-active-label-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(SETTINGS_URL);
            // The button label embeds the active email so the active-account scope is unambiguous.
            const connectBtn = page.getByRole('button', { name: new RegExp(`Connect Google Calendar for ${email}`) });
            await expect(connectBtn).toBeVisible({ timeout: 10_000 });

            // The scope-notice banner names the active account and points to the account switcher.
            await expect(page.getByText(/Managing calendars for/)).toBeVisible();
            await expect(page.getByText(email, { exact: true })).toBeVisible();
        });
    });

    test('clicking Connect goes straight to /calendar/auth/google?login_hint=<active.email> (no picker dialog)', async ({ browser }) => {
        const email = `connect-active-redirect-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(SETTINGS_URL);
            const captured: { href: string | null } = { href: null };
            await interceptOAuthStart(page, captured);

            const connectBtn = page.getByRole('button', { name: new RegExp(`Connect Google Calendar for ${email}`) });
            await expect(connectBtn).toBeVisible({ timeout: 10_000 });
            await connectBtn.click();

            // The picker dialog has been removed — the click should drive the redirect directly.
            // No "Connect this calendar account" CTA exists any more.
            await expect.poll(() => captured.href, { timeout: 15_000 }).not.toBeNull();
            const url = new URL(captured.href ?? '');
            expect(url.pathname).toBe('/calendar/auth/google');
            expect(url.searchParams.get('login_hint')).toBe(email);

            // Sanity: the old picker dialog must not appear.
            await expect(page.getByRole('dialog', { name: /Connect Google Calendar/i })).toHaveCount(0);
        });
    });
});

test.describe('calendar connect — OAuth mismatch error', () => {
    test('hitting calendarConnectError=mismatch in settings shows the inline error', async ({ browser }) => {
        const email = `connect-mismatch-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            // Use the dev-only simulate endpoint so the redirect path mirrors production: server
            // responds 302 → /settings?calendarConnectError=mismatch, browser follows the redirect.
            await page.goto(DEV_SIMULATE_MISMATCH_URL);
            await page.waitForURL(/calendarConnectError=mismatch/);

            // ConnectMismatchError component renders this exact title, color="error.main".
            await expect(page.getByText("Couldn't connect that Google Calendar account")).toBeVisible();
        });
    });

    test('dismissing the mismatch error clears the query param so refresh does not re-show it', async ({ browser }) => {
        const email = `connect-mismatch-dismiss-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(DEV_SIMULATE_MISMATCH_URL);
            await page.waitForURL(/calendarConnectError=mismatch/);

            await page.getByRole('button', { name: 'Dismiss' }).click();
            // The router's navigate(replace) drops the query param.
            await expect(page).toHaveURL(/\/settings($|\?(?!.*calendarConnectError))/);
        });
    });
});
