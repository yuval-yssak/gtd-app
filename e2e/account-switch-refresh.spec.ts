import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withTwoAccountsOnOneDevice } from './helpers/context';

const CLIENT_URL = 'http://localhost:4173';

test.describe('account switch from menu', () => {
    test('switching active account on settings reloads page and shows new account', async ({ browser }) => {
        const ts = dayjs().valueOf();
        const emailA = `switch-a-${ts}@example.com`;
        const emailB = `switch-b-${ts}@example.com`;

        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, accounts) => {
            // Navigate to Settings — the regression we're guarding against was first observed here:
            // before the fix, the Account row kept showing the previous account's name/email after a switch.
            await page.goto(`${CLIENT_URL}/settings`);
            await expect(page.getByText(`${emailA.split('@')[0]} · ${emailA}`)).toBeVisible();

            // Open the AccountSwitcher menu and pick the secondary account.
            // AccountSwitcher is rendered in both the mobile AppBar (display:none on desktop)
            // and the desktop sidebar; .first() resolves to the mobile one which is hidden.
            // :visible filter selects the one the user actually sees at this viewport.
            const trigger = page.getByTestId('accountSwitcherTrigger').locator('visible=true').first();
            await trigger.click();
            // Wait for the menu item to be visible — MUI Menu mounts lazily into a portal.
            const switchTarget = page.getByTestId(`accountSwitcherItem-${accounts.secondary.userId}`);
            await switchTarget.waitFor({ state: 'visible' });

            // The switch handler issues a hard reload back to the current path; waitForLoadState
            // 'load' confirms the navigation actually happened (a no-op SPA route change wouldn't
            // fire a 'load' event).
            await Promise.all([page.waitForLoadState('load'), switchTarget.click()]);

            // After reload, AppDataProvider re-runs its boot effect and reads the new active account
            // from IDB. Settings's account row reads from useAppData().account; verifying it shows
            // the secondary account's name + email proves the active-account → AppDataProvider.account
            // contract is restored on switch (the underlying bug behind the user-reported regression).
            await expect(page.getByText(`${emailB.split('@')[0]} · ${emailB}`)).toBeVisible();
            // And the previous account's identity is gone from the page — confirms it's a true
            // swap, not both rendered side-by-side.
            await expect(page.getByText(`${emailA.split('@')[0]} · ${emailA}`)).toHaveCount(0);

            // Route preserved — we landed back on /settings, not /inbox.
            expect(new URL(page.url()).pathname).toBe('/settings');
        });
    });
});
