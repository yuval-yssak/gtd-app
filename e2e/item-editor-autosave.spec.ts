import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice, withTwoLoggedInDevices } from './helpers/context';
import { gtd } from './helpers/gtd';

// Hybrid save model in the item editor: title/notes autosave (debounced, undoable) while
// status/schedule/meta still commit via the explicit Save button. The editor also live-merges
// remote changes while open, surfacing a conflict notice when both sides touched the same field.

test.describe('item editor — title/notes autosave', () => {
    test('title autosaves without pressing Save, and Undo restores it', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `item-autosave-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.collect(page, 'Autosave me');
            await page.goto('/inbox');
            await page.waitForSelector('text=Autosave me');

            await page.getByRole('button', { name: 'Edit' }).first().click();
            const dialog = page.getByRole('dialog', { name: 'Edit item' });
            await dialog.getByLabel('Title').fill('Autosaved title');

            // No Save click — the debounce commits and offers Undo.
            await expect(page.getByTestId('undoSnackbar')).toBeVisible();
            await expect.poll(async () => (await gtd.listItems(page)).map((i) => i.title)).toContain('Autosaved title');

            await page.getByTestId('undoSnackbarButton').click();
            await expect.poll(async () => (await gtd.listItems(page)).map((i) => i.title)).toContain('Autosave me');
            // The open editor reflects the undo too.
            await expect(dialog.getByLabel('Title')).toHaveValue('Autosave me');
        });
    });

    test('closing the dialog right after typing persists the tail of the burst (flush-on-unmount)', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `item-autosave-flush-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.collect(page, 'Quick edit');
            await page.goto('/inbox');
            await page.waitForSelector('text=Quick edit');

            await page.getByRole('button', { name: 'Edit' }).first().click();
            const dialog = page.getByRole('dialog', { name: 'Edit item' });
            await dialog.getByLabel('Title').fill('Quick edit — typed and closed');
            await dialog.getByRole('button', { name: 'Cancel' }).click();

            await expect.poll(async () => (await gtd.listItems(page)).map((i) => i.title)).toContain('Quick edit — typed and closed');
        });
    });

    test('Cancel discards structural edits but keeps autosaved text', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `item-autosave-cancel-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.collect(page, 'Structure stays');
            await page.goto('/inbox');
            await page.waitForSelector('text=Structure stays');

            await page.getByRole('button', { name: 'Edit' }).first().click();
            const dialog = page.getByRole('dialog', { name: 'Edit item' });
            await dialog.getByLabel('Title').fill('Structure stays — renamed');
            // Structural edit: pick a status chip, then Cancel instead of Save.
            await dialog.getByRole('button', { name: 'Next Action' }).click();
            await expect(page.getByTestId('undoSnackbar')).toBeVisible(); // title committed
            await dialog.getByRole('button', { name: 'Cancel' }).click();

            await expect.poll(async () => (await gtd.listItems(page)).map((i) => i.title)).toContain('Structure stays — renamed');
            const item = (await gtd.listItems(page)).find((i) => i.title === 'Structure stays — renamed');
            expect(item?.status).toBe('inbox'); // the un-saved status change was discarded
        });
    });
});

test.describe('item editor — save undo snackbar', () => {
    test('after clarifying an inbox item, the undo snackbar links back to the item', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `clarify-view-link-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Clarify and view');
            await page.goto('/inbox');
            await page.waitForSelector('text=Clarify and view');

            // UI-driven clarify: move to Next Action and commit via the explicit Save button,
            // which closes the editor and offers the "Item updated" undo with a View link.
            await page.getByRole('button', { name: 'Edit' }).first().click();
            const dialog = page.getByRole('dialog', { name: 'Edit item' });
            await dialog.getByRole('button', { name: 'Next Action' }).click();
            await dialog.getByRole('button', { name: 'Save changes' }).click();

            // The save undo offer carries a View link back to the just-clarified item.
            const viewButton = page.getByTestId('undoSnackbarViewButton');
            await expect(viewButton).toBeVisible();
            await viewButton.click();

            // View navigates to the item's page (the route may append a search param) and the snackbar goes away.
            await expect(page).toHaveURL(new RegExp(`/item/${item._id}(\\?|$)`));
            await expect(page.getByTestId('undoSnackbar')).toHaveCount(0);
        });
    });
});

test.describe('item editor — creation date', () => {
    test('shows when the item was first created', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `item-created-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Created stamp');
            await page.goto('/inbox');
            await page.waitForSelector('text=Created stamp');

            await page.getByRole('button', { name: 'Edit' }).first().click();
            const dialog = page.getByRole('dialog', { name: 'Edit item' });
            const created = dialog.getByTestId('itemEditorCreatedAt');
            // Two independent assertions: the regex pins the display format (a self-derived
            // dayjs.format() on both sides could not catch a format regression), and the
            // toContainText proves it renders *this* item's date rather than a constant.
            await expect(created).toHaveText(/^Created [A-Z][a-z]{2} \d{1,2}, \d{4} \d{1,2}:\d{2} (AM|PM)$/);
            await expect(created).toContainText(dayjs(item.createdTs).format('MMM D, YYYY'));

            // The caption lives in the shared body, so the page chrome gets it too.
            await page.goto(`/item/${item._id}`);
            await expect(page.getByTestId('itemEditorCreatedAt')).toContainText(dayjs(item.createdTs).format('MMM D, YYYY'));
        });
    });
});

test.describe('item editor — live merge while open', () => {
    test('a remote rename flows into the open editor when the field is untouched', async ({ browser }) => {
        const email = `item-merge-${dayjs().valueOf()}@example.com`;
        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            const item = await gtd.collect(page1, 'Merge target');
            await gtd.flush(page1);
            await gtd.pull(page2);

            await page1.goto('/inbox');
            await page1.waitForSelector('text=Merge target');
            await page1.getByRole('button', { name: 'Edit' }).first().click();
            const dialog = page1.getByRole('dialog', { name: 'Edit item' });
            await expect(dialog.getByLabel('Title')).toHaveValue('Merge target');

            // Device 2 renames while device 1's editor sits open with a clean title field.
            const onDevice2 = (await gtd.listItems(page2)).find((i) => i._id === item._id);
            if (!onDevice2) throw new Error('item did not reach device 2');
            await gtd.updateItem(page2, { ...onDevice2, title: 'Renamed remotely' });
            await gtd.flush(page2);

            // SSE → pull → live merge adopts the clean field. No conflict notice.
            await expect(dialog.getByLabel('Title')).toHaveValue('Renamed remotely', { timeout: 15_000 });
            await expect(page1.getByTestId('itemEditorConflictNotice')).toHaveCount(0);
        });
    });

    test('a dirty structural field collides with a remote change → notice + "Use their version"', async ({ browser }) => {
        const email = `item-conflict-${dayjs().valueOf()}@example.com`;
        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            const item = await gtd.collect(page1, 'Conflict target');
            await gtd.flush(page1);
            await gtd.pull(page2);

            await page1.goto('/inbox');
            await page1.waitForSelector('text=Conflict target');
            await page1.getByRole('button', { name: 'Edit' }).first().click();
            const dialog = page1.getByRole('dialog', { name: 'Edit item' });
            // Dirty the status locally (structural — not autosaved, stays pending until Save).
            await dialog.getByRole('button', { name: 'Waiting For' }).click();

            // Device 2 moves the same item to Someday/Maybe.
            const onDevice2 = (await gtd.listItems(page2)).find((i) => i._id === item._id);
            if (!onDevice2) throw new Error('item did not reach device 2');
            await gtd.clarifyToSomedayMaybe(page2, onDevice2);
            await gtd.flush(page2);

            const notice = page1.getByTestId('itemEditorConflictNotice');
            await expect(notice).toBeVisible({ timeout: 15_000 });
            await expect(notice).toContainText('Status');

            await page1.getByTestId('itemEditorUseTheirs').click();
            await expect(notice).toHaveCount(0);
            // Someday/Maybe explainer copy proves the adopted status now drives the form.
            await expect(dialog.getByText('Parked for later review', { exact: false })).toBeVisible();
        });
    });
});
