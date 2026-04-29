import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice, withTwoAccountsOnOneDevice } from './helpers/context';

// E2E coverage for Step 2 of the multi-account calendar plan: the pre-OAuth account picker
// (ConnectAccountPickerDialog) and the post-OAuth mismatch error UI.
//
// We do NOT drive real Google OAuth from these tests. Instead:
//   - For the redirect path: stub `window.location.href` so the test can assert the URL the
//     app would navigate to (login_hint=<email>) without actually leaving the page.
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

test.describe('calendar connect — OAuth account picker', () => {
    test('Connect button opens the account picker listing the active Google account', async ({ browser }) => {
        const email = `connect-single-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(SETTINGS_URL);
            await expect(page.getByRole('button', { name: 'Connect Google Calendar' })).toBeVisible({ timeout: 10_000 });
            await page.getByRole('button', { name: 'Connect Google Calendar' }).click();

            // Dialog renders the account email and the per-row connect CTA.
            await expect(page.getByRole('dialog', { name: /Connect Google Calendar/i })).toBeVisible();
            await expect(page.getByText(email, { exact: true })).toBeVisible();
            await expect(page.getByText('Connect this calendar account')).toBeVisible();
        });
    });

    test('picking the active account redirects with login_hint=<email>', async ({ browser }) => {
        const email = `connect-redirect-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(SETTINGS_URL);
            const captured: { href: string | null } = { href: null };
            await interceptOAuthStart(page, captured);

            await expect(page.getByRole('button', { name: 'Connect Google Calendar' })).toBeVisible({ timeout: 10_000 });
            await page.getByRole('button', { name: 'Connect Google Calendar' }).click();
            await page.getByText('Connect this calendar account').click();

            await expect.poll(() => captured.href, { timeout: 15_000 }).not.toBeNull();
            const url = new URL(captured.href ?? '');
            expect(url.pathname).toBe('/calendar/auth/google');
            expect(url.searchParams.get('login_hint')).toBe(email);
        });
    });

    test('picker lists every Google-provider account when the device hosts multiple', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `connect-multi-a-${stamp}@example.com`;
        const emailB = `connect-multi-b-${stamp}@example.com`;
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page) => {
            await page.goto(SETTINGS_URL);

            await expect(page.getByRole('button', { name: 'Connect Google Calendar' })).toBeVisible({ timeout: 10_000 });
            await page.getByRole('button', { name: 'Connect Google Calendar' }).click();

            // Both accounts surface their own ListItemButton with their email visible.
            await expect(page.getByText(emailA, { exact: true })).toBeVisible();
            await expect(page.getByText(emailB, { exact: true })).toBeVisible();
        });
    });

    test('picking the non-active account redirects with that email in login_hint after switching session', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `connect-pivot-a-${stamp}@example.com`;
        const emailB = `connect-pivot-b-${stamp}@example.com`;
        // emailA is the active session by default (activeIndex=0). We pick emailB → multiSession.setActive(B) → redirect with login_hint=B.
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page) => {
            await page.goto(SETTINGS_URL);
            const captured: { href: string | null } = { href: null };
            await interceptOAuthStart(page, captured);

            await expect(page.getByRole('button', { name: 'Connect Google Calendar' })).toBeVisible({ timeout: 10_000 });
            await page.getByRole('button', { name: 'Connect Google Calendar' }).click();
            // Click the row whose secondary text is emailB — Material UI renders `secondary` inside the same ListItemButton.
            await page.getByRole('button', { name: new RegExp(emailB) }).click();

            await expect.poll(() => captured.href, { timeout: 15_000 }).not.toBeNull();
            const url = new URL(captured.href ?? '');
            expect(url.searchParams.get('login_hint')).toBe(emailB);
        });
    });

    test('empty state surfaces an explanatory message when no Google accounts are signed in', async ({ browser }) => {
        const email = `connect-empty-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            // Forge a non-google account in IDB so the picker filter (provider === 'google') excludes everyone.
            // Mutating the cached IDB row is enough — the dialog reads via useAccounts which subscribes to IDB.
            await page.evaluate(async (uid) => {
                type AccountIDB = { provider: string; id: string };
                type DBHandle = {
                    get(store: 'accounts', key: string): Promise<AccountIDB | undefined>;
                    put(store: 'accounts', value: AccountIDB): Promise<unknown>;
                };
                const dbHandle = (window as unknown as { __gtd: { db: DBHandle } }).__gtd.db;
                const acct = await dbHandle.get('accounts', uid);
                if (acct) {
                    acct.provider = 'github';
                    await dbHandle.put('accounts', acct);
                }
            }, await readActiveAccountId(page));
            await page.reload();
            await page.goto(SETTINGS_URL);

            await expect(page.getByRole('button', { name: 'Connect Google Calendar' })).toBeVisible({ timeout: 10_000 });
            await page.getByRole('button', { name: 'Connect Google Calendar' }).click();
            await expect(page.getByText(/No Google accounts are signed into GTD on this device/)).toBeVisible();
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

async function readActiveAccountId(page: Page): Promise<string> {
    const id = await page.evaluate(async () => {
        type Harness = { getActiveAccountId(): Promise<string | null> };
        const h = (window as unknown as { __gtd: Harness }).__gtd;
        return h.getActiveAccountId();
    });
    if (!id) {
        throw new Error('no active account id');
    }
    return id;
}
