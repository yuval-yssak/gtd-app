import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice, withTwoAccountsOnOneDevice } from './helpers/context';

const CLIENT_URL = 'http://localhost:4173';

// AccountSwitcher renders one trigger in the mobile AppBar (display:none on desktop) and one
// in the desktop sidebar. visible=true picks the one rendered at the current viewport.
async function openAccountMenu(page: Page) {
    const trigger = page.getByTestId('accountSwitcherTrigger').locator('visible=true').first();
    await trigger.click();
}

// Both AccountSwitcher instances mount their own Backdrop; only one is visible per viewport.
function visibleBackdrop(page: Page) {
    return page.getByTestId('accountActionBackdrop').locator('visible=true').first();
}

// Same caveat as above for the error Snackbar — Alert lives inside the visible Snackbar.
function visibleActionError(page: Page) {
    return page.getByTestId('accountActionError').locator('visible=true').first();
}

// Add a deterministic delay to the sign-out endpoint so the backdrop's visible window is
// observable from the test. URL glob (not literal) so a query string can't slip past us.
async function stallSignOutEndpoint(page: Page, ms: number): Promise<void> {
    await page.route('**/devices/signout*', async (route) => {
        await new Promise((r) => setTimeout(r, ms));
        await route.continue();
    });
}

// Aborts Better Auth's sign-out endpoint so the underlying authClient.signOut() promise
// rejects with a real network error. /devices/signout is intentionally best-effort and
// doesn't propagate non-2xx responses, so stubbing that one wouldn't reach the catch path
// in withPending. Better Auth's /auth/sign-out is the call whose rejection we want to assert on.
async function failBetterAuthSignOut(page: Page): Promise<void> {
    await page.route('**/auth/sign-out*', async (route) => {
        await route.abort('failed');
    });
}

test.describe('account action backdrop', () => {
    test('sign-out renders the blocking backdrop with a "Signing out…" label while in flight', async ({ browser }) => {
        const email = `signout-backdrop-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(`${CLIENT_URL}/inbox`);
            await stallSignOutEndpoint(page, 1500);
            await openAccountMenu(page);

            const signOut = page.getByRole('menuitem', { name: 'Sign out', exact: true });
            await signOut.waitFor({ state: 'visible' });
            await signOut.click();

            const backdrop = visibleBackdrop(page);
            await expect(backdrop).toBeVisible();
            await expect(backdrop).toContainText('Signing out…');
            // aria-busy proves the announcement contract for screen-reader users
            await expect(backdrop).toHaveAttribute('aria-busy', 'true');

            await page.waitForURL(`${CLIENT_URL}/login`, { timeout: 10_000 });
            expect(new URL(page.url()).pathname).toBe('/login');
        });
    });

    test('sign-out failure clears the backdrop and surfaces an error to the user', async ({ browser }) => {
        const email = `signout-fail-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(`${CLIENT_URL}/inbox`);
            await failBetterAuthSignOut(page);
            await openAccountMenu(page);

            const signOut = page.getByRole('menuitem', { name: 'Sign out', exact: true });
            await signOut.waitFor({ state: 'visible' });
            await signOut.click();

            const errorAlert = visibleActionError(page);
            await expect(errorAlert).toBeVisible();
            await expect(errorAlert).toContainText("Couldn't sign out");

            // Backdrop must be gone — the original UX bug was "no feedback during a long wait";
            // the symmetric failure-mode bug would be "backdrop stuck forever after a failed call".
            await expect(visibleBackdrop(page)).toBeHidden();

            // We're still on /inbox, not /login — the failed sign-out did not navigate.
            expect(new URL(page.url()).pathname).toBe('/inbox');
        });
    });

    test('switching account renders the blocking backdrop with a "Switching account…" label', async ({ browser }) => {
        const ts = dayjs().valueOf();
        const emailA = `switch-backdrop-a-${ts}@example.com`;
        const emailB = `switch-backdrop-b-${ts}@example.com`;

        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, accounts) => {
            await page.goto(`${CLIENT_URL}/inbox`);
            // Stall the multi-session set-active call so the backdrop has a guaranteed visible window.
            // Better Auth is mounted at basePath '/auth' (see client/src/lib/authClient.ts), so the
            // multi-session endpoint lives at /auth/multi-session/set-active. Glob to allow query strings.
            await page.route('**/auth/multi-session/set-active*', async (route) => {
                await new Promise((r) => setTimeout(r, 1500));
                await route.continue();
            });
            await openAccountMenu(page);

            const switchTarget = page.getByTestId(`accountSwitcherItem-${accounts.secondary.userId}`);
            await switchTarget.waitFor({ state: 'visible' });
            await switchTarget.click();

            // Backdrop label proves the in-flight UX. The post-switch correctness contract
            // (Settings shows the new account) is already covered by account-switch-refresh.spec.ts;
            // re-asserting it here would just race the reload that happens after the stall completes.
            const backdrop = visibleBackdrop(page);
            await expect(backdrop).toBeVisible();
            await expect(backdrop).toContainText('Switching account…');
            await expect(backdrop).toHaveAttribute('aria-busy', 'true');
        });
    });

    test('the backdrop blocks input while the sign-out chain is in flight', async ({ browser }) => {
        const email = `signout-blocking-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(`${CLIENT_URL}/inbox`);
            await stallSignOutEndpoint(page, 1500);
            await openAccountMenu(page);

            const signOut = page.getByRole('menuitem', { name: 'Sign out', exact: true });
            await signOut.waitFor({ state: 'visible' });
            await signOut.click();

            // Two contracts under test:
            //   1. The MUI Menu portal closes on click (onClick={closeMenu} on the Menu),
            //      so the menu items unmount immediately — there's no second click to make.
            //   2. The Backdrop renders with default pointer-events: auto and a z-index above
            //      the AppBar; an attempt to click the AccountSwitcher trigger now lands on
            //      the Backdrop, not the button. We prove this by trying a non-forced click
            //      with a short timeout — Playwright's actionability check fails because the
            //      target is covered.
            await expect(page.getByRole('menuitem', { name: 'Sign out', exact: true })).toHaveCount(0);

            const trigger = page.getByTestId('accountSwitcherTrigger').locator('visible=true').first();
            const blockedClick = await trigger
                .click({ timeout: 1000, trial: false })
                .then(() => 'allowed' as const)
                .catch(() => 'blocked' as const);
            expect(blockedClick).toBe('blocked');

            // Drain the stall so context teardown isn't fighting an in-flight request.
            await page.waitForURL(`${CLIENT_URL}/login`, { timeout: 10_000 });
        });
    });
});
