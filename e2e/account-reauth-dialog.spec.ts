import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// E2E coverage for the blocking account-reauth dialog. When the sync orchestrator flags an
// account as needing re-login (no Better Auth multi-session entry on this device), a modal
// dialog must interrupt the whole app — the old status-bar banner alone was too easy to miss.
// "Not now" closes the dialog but the banner stays as a persistent reminder, and a re-flag on
// the next sync cycle must NOT re-open the acknowledged dialog.

const CLIENT_URL = 'http://localhost:4173';

/** Fires the same window event the sync orchestrator dispatches when an account can't sync. */
async function flagAccountNeedsReauth(page: Page, userId: string): Promise<void> {
    await page.evaluate((id) => {
        window.dispatchEvent(new CustomEvent('gtd:account-needs-reauth', { detail: { userId: id } }));
    }, userId);
}

async function activeAccountId(page: Page): Promise<string> {
    const userId = await gtd.getActiveAccountId(page);
    if (!userId) {
        throw new Error('expected an active account to flag for reauth');
    }
    return userId;
}

test.describe('account reauth dialog', () => {
    test('flag opens a blocking dialog; Not now falls back to the banner; re-flag stays closed', async ({ browser }) => {
        const email = `reauth-dialog-${dayjs().valueOf()}@example.com`;

        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(`${CLIENT_URL}/inbox`);
            await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();

            const userId = await activeAccountId(page);
            await flagAccountNeedsReauth(page, userId);

            // The modal interrupts the app and offers a Re-login action for the account.
            const dialog = page.getByTestId('accountReauthDialog');
            await expect(dialog).toBeVisible();
            await expect(dialog.getByText(email)).toBeVisible();
            await expect(dialog.getByTestId('accountReauthDialogRelogin')).toBeVisible();

            await dialog.getByTestId('accountReauthDialogNotNow').click();
            await expect(dialog).not.toBeVisible();

            // The status-bar banner keeps warning after the dialog is acknowledged. The banner
            // double-mounts inside AppNav's drawers, so scope to the visible instance.
            const banner = page.getByText(`Your account ${email} needs re-login to sync.`).filter({ visible: true });
            await expect(banner).toBeVisible();

            // The orchestrator re-dispatches every sync cycle — the acknowledged dialog must not
            // re-open and nag on each cycle. The banner staying up proves the re-flag reached the
            // store rather than the assertion passing vacuously on an inert page.
            await flagAccountNeedsReauth(page, userId);
            await expect(banner).toBeVisible();
            await expect(dialog).not.toBeVisible();

            // Suppression is per-account: flagging a DIFFERENT account re-opens the dialog. This
            // second id has no local account row, so it must surface with the generic label rather
            // than being silently dropped (the load-race / stale-flag edge).
            await flagAccountNeedsReauth(page, 'e2e-unknown-user');
            await expect(dialog).toBeVisible();
            await expect(dialog.getByText('Unknown account')).toBeVisible();

            await dialog.getByTestId('accountReauthDialogNotNow').click();
            await expect(dialog).not.toBeVisible();
        });
    });

    test('re-login resolution in one tab closes the stale dialog in every other tab', async ({ browser }) => {
        const email = `reauth-cross-tab-${dayjs().valueOf()}@example.com`;

        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(`${CLIENT_URL}/inbox`);
            await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
            const userId = await activeAccountId(page);

            // Second tab in the same browser context — same device, its own module-level store.
            const secondTab = await page.context().newPage();
            await secondTab.goto(`${CLIENT_URL}/inbox`);
            await expect(secondTab.getByRole('heading', { name: 'Inbox' })).toBeVisible();

            // The orchestrator flags the broken account in each open tab independently.
            await flagAccountNeedsReauth(page, userId);
            await flagAccountNeedsReauth(secondTab, userId);
            await expect(page.getByTestId('accountReauthDialog')).toBeVisible();
            await expect(secondTab.getByTestId('accountReauthDialog')).toBeVisible();

            // Drive the SAME call auth.callback makes after a successful OAuth re-login in the
            // first tab. The cross-tab storage broadcast must clear the second tab's dialog AND
            // banner without a reload — and the first tab's own dialog clears synchronously.
            await page.evaluate((id) => {
                (window as unknown as { __gtd: { announceReauthResolved(userId: string): void } }).__gtd.announceReauthResolved(id);
            }, userId);

            await expect(page.getByTestId('accountReauthDialog')).not.toBeVisible();
            await expect(secondTab.getByTestId('accountReauthDialog')).not.toBeVisible();
            await expect(secondTab.getByText(`Your account ${email} needs re-login to sync.`)).toHaveCount(0);

            await secondTab.close();
        });
    });
});
