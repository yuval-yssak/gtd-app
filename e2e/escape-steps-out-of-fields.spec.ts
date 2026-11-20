import { expect, type Locator, type Page, test } from '@playwright/test';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// Escape steps out one level: the first Escape in a text field only leaves the field — focus
// parks on the field's box, so the `g` jumps work right away without Tab (which the notes editor
// keeps for indenting), and Enter steps back in; the next Escape is the page's own.

/** The design-system field box an Escape from `control` parks focus on. */
function fieldBoxOf(control: Locator) {
    return control.locator('xpath=ancestor::*[@data-field-parking][1]');
}

async function outlineOf(box: Locator) {
    return box.evaluate((element) => {
        const style = getComputedStyle(element);
        return `${style.outlineWidth} ${style.outlineOffset} ${style.borderColor}`;
    });
}

async function jumpToSearch(page: Page) {
    await page.keyboard.press('g');
    await page.keyboard.press('f');
    await expect(page).toHaveURL(/\/search/);
}

test.describe('Escape steps out of text fields', () => {
    test('title field: Esc leaves the field and stays on the page; g f then jumps to Search', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `esc-title-${uniqueStamp()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Step out of the title');
            await page.goto(`/item/${item._id}`);
            const title = page.getByRole('textbox', { name: 'Title' });
            await title.click();
            await expect(title).toBeFocused();

            await page.keyboard.press('Escape');
            await expect(title).not.toBeFocused();
            await expect(fieldBoxOf(title)).toBeFocused();
            await expect(page).toHaveURL(new RegExp(`/item/${item._id}`));

            await jumpToSearch(page);
        });
    });

    test('title field: a second Esc leaves the page', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `esc-title-twice-${uniqueStamp()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Escape twice');
            await page.goto(`/item/${item._id}`);
            const title = page.getByRole('textbox', { name: 'Title' });
            await title.click();

            await page.keyboard.press('Escape');
            await expect(title).not.toBeFocused();
            await page.keyboard.press('Escape');
            await expect(page).toHaveURL(/\/inbox/);
        });
    });

    test('empty notes editor: Esc leaves the editor without leaving the page; g f then jumps to Search', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `esc-empty-notes-${uniqueStamp()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'No notes yet');
            await page.goto(`/item/${item._id}`);
            const notesEditor = page.getByRole('textbox', { name: 'Notes (Markdown)' });
            await expect(notesEditor).toBeVisible({ timeout: 15_000 });
            await notesEditor.click();
            await expect(notesEditor).toBeFocused();

            await page.keyboard.press('Escape');
            await expect(notesEditor).not.toBeFocused();
            await expect(page).toHaveURL(new RegExp(`/item/${item._id}`));

            await jumpToSearch(page);
        });
    });

    test('notes editor with text: Esc returns to the preview; g f then jumps to Search', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `esc-notes-${uniqueStamp()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Has notes');
            await gtd.updateItem(page, { ...item, notes: 'Some notes' });
            await gtd.flush(page);
            await page.goto(`/item/${item._id}`);
            await page.getByRole('button', { name: 'Edit notes' }).click();
            const notesEditor = page.getByRole('textbox', { name: 'Notes (Markdown)' });
            await expect(notesEditor).toBeFocused({ timeout: 15_000 });

            await page.keyboard.press('Escape');
            await expect(page.getByTestId('pageNotesPreview')).toBeVisible();

            await jumpToSearch(page);
        });
    });

    test('inbox capture: Esc parks focus on the field box, Enter steps back in to keep typing', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `esc-capture-${uniqueStamp()}@example.com`, async (page) => {
            await page.goto('/inbox');
            const captureInput = page.getByRole('textbox', { name: 'Capture to inbox' });
            await captureInput.fill('Half a thought');

            await page.keyboard.press('Escape');
            await expect(page.getByTestId('inboxCaptureField')).toBeFocused();

            // Enter re-enters the field without capturing the draft or typing a newline.
            await page.keyboard.press('Enter');
            await expect(captureInput).toBeFocused();
            await expect(captureInput).toHaveValue('Half a thought');
            await page.keyboard.type(' more');
            await expect(captureInput).toHaveValue('Half a thought more');
        });
    });

    test('inbox capture: from the parked field box, g f jumps to Search', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `esc-capture-jump-${uniqueStamp()}@example.com`, async (page) => {
            await page.goto('/inbox');
            await page.getByRole('textbox', { name: 'Capture to inbox' }).click();
            await page.keyboard.press('Escape');
            await expect(page.getByTestId('inboxCaptureField')).toBeFocused();

            await jumpToSearch(page);
        });
    });

    test('empty notes editor: Enter from the parked editor box steps back into it', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `esc-notes-enter-${uniqueStamp()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Back into notes');
            await page.goto(`/item/${item._id}`);
            const notesEditor = page.getByRole('textbox', { name: 'Notes (Markdown)' });
            await expect(notesEditor).toBeVisible({ timeout: 15_000 });
            await notesEditor.click();
            const editorBox = page.getByTestId('markdownNotesEditor');
            const editingRing = await outlineOf(editorBox);

            await page.keyboard.press('Escape');
            await expect(editorBox).toBeFocused();
            // Parked must not look like typing: letters are shortcuts here (t would pick Trash).
            await expect.poll(() => outlineOf(editorBox)).not.toBe(editingRing);
            await page.keyboard.press('Enter');
            await expect(notesEditor).toBeFocused();
            // The Enter only re-entered: typing lands on the editor's single line, with no newline above it.
            await page.keyboard.type('first line');
            await expect(notesEditor.locator('.cm-line')).toHaveCount(1);
            await expect(notesEditor).toHaveText('first line');
        });
    });
});
