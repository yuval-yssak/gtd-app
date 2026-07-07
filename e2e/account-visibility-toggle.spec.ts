import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice, withTwoAccountsOnOneDevice } from './helpers/context';

// E2E coverage for the per-account visibility toggles: the avatar row next to the account
// switcher that hides/shows one signed-in account's data across the unified view. Hiding is
// display-only (localStorage-persisted), so seeding IDB rows directly per userId is enough.

const CLIENT_URL = 'http://localhost:4173';
const INBOX_URL = `${CLIENT_URL}/inbox`;

/**
 * Inserts a seed StoredItem directly into the device's IDB tagged with the supplied userId.
 * Bypasses the `__gtd.collect` resolveUserId path so the active-account-based shortcut
 * doesn't force us to pivot Better Auth sessions just to materialize a row in IDB.
 */
async function seedItemForUser(page: Page, userId: string, title: string): Promise<string> {
    return page.evaluate(
        ({ userId, title }) => {
            // Inline IDB-row shape so we don't have to import types into the page context.
            type IDBItem = { _id: string; userId: string; status: string; title: string; createdTs: string; updatedTs: string };
            type DBHandle = { put(store: 'items', value: IDBItem): Promise<unknown> };
            const dbHandle = (window as unknown as { __gtd: { db: DBHandle } }).__gtd.db;
            const id = `seed-${Math.random().toString(36).slice(2, 10)}`;
            const now = new Date().toISOString();
            const item: IDBItem = { _id: id, userId, status: 'inbox', title, createdTs: now, updatedTs: now };
            return dbHandle.put('items', item).then(() => id);
        },
        { userId, title },
    );
}

/** Re-renders the inbox by navigating so the AppDataProvider re-reads IDB after a seed. */
async function reloadInbox(page: Page): Promise<void> {
    await page.goto(INBOX_URL);
    await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
}

/**
 * The toggle renders once per AccountSwitcher mount point (permanent drawer + keepMounted
 * temporary drawer + mobile AppBar); on the desktop viewport only the permanent drawer's
 * instance is interactable, so scope every query to the visible one.
 */
function visibleToggleFor(page: Page, userId: string) {
    return page.getByTestId(`accountVisibilityToggle-${userId}`).filter({ visible: true });
}

test.describe('account visibility toggles', () => {
    test('hiding an account removes its items from the unified view and persists across reload', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `vistoggle-a-${stamp}@example.com`;
        const emailB = `vistoggle-b-${stamp}@example.com`;

        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            await seedItemForUser(page, active.userId, 'A — stays visible');
            await seedItemForUser(page, secondary.userId, 'B — gets hidden');
            await reloadInbox(page);

            await expect(page.getByText('A — stays visible')).toBeVisible();
            await expect(page.getByText('B — gets hidden')).toBeVisible();

            // Hide account B — its item disappears, A's item stays.
            await visibleToggleFor(page, secondary.userId).click();
            await expect(page.getByText('B — gets hidden')).toBeHidden();
            await expect(page.getByText('A — stays visible')).toBeVisible();
            await expect(visibleToggleFor(page, secondary.userId)).toHaveAttribute('data-account-hidden', 'true');

            // The hidden state persists across a full reload (localStorage-backed).
            await reloadInbox(page);
            await expect(page.getByText('A — stays visible')).toBeVisible();
            await expect(page.getByText('B — gets hidden')).toBeHidden();

            // Toggle back — B's item reappears.
            await visibleToggleFor(page, secondary.userId).click();
            await expect(page.getByText('B — gets hidden')).toBeVisible();
            await expect(visibleToggleFor(page, secondary.userId)).toHaveAttribute('data-account-hidden', 'false');
        });
    });

    test('a deep link to a hidden account item still resolves (by-id lookups stay unfiltered)', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `vistoggle-deep-a-${stamp}@example.com`;
        const emailB = `vistoggle-deep-b-${stamp}@example.com`;

        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { secondary }) => {
            const hiddenItemId = await seedItemForUser(page, secondary.userId, 'B — deep linked');
            await reloadInbox(page);

            await visibleToggleFor(page, secondary.userId).click();
            await expect(page.getByText('B — deep linked')).toBeHidden();

            // Navigating straight to the item must open the editor, not "Item not found".
            await page.goto(`${CLIENT_URL}/item/${hiddenItemId}`);
            await expect(page.getByTestId('itemPageWrapper')).toBeVisible();
            await expect(page.getByLabel('Title')).toHaveValue('B — deep linked');
            await expect(page.getByText('Item not found — it may have already been processed.')).toBeHidden();
        });
    });

    test('the toggle row is suppressed on a single-account device', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const email = `vistoggle-single-${stamp}@example.com`;

        await withOneLoggedInDevice(browser, email, async (page) => {
            await reloadInbox(page);
            // The switcher trigger is present, but no visibility toggle renders for one account.
            await expect(page.getByTestId('accountSwitcherTrigger').filter({ visible: true })).toBeVisible();
            await expect(page.locator('[data-testid^="accountVisibilityToggle-"]')).toHaveCount(0);
        });
    });
});
