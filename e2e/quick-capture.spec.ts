import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import type { StoredDraft } from '../client/src/types/MyDB';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Reads the drafts store through the dev-tools harness so specs can wait for the debounced IDB
// write deterministically instead of sleeping past the debounce interval.
function readDrafts(page: Page): Promise<StoredDraft[]> {
    return page.evaluate(() => (window as unknown as { __gtd: { db: { getAll(store: 'drafts'): Promise<StoredDraft[]> } } }).__gtd.db.getAll('drafts'));
}

// Global quick capture: a FAB on every authenticated page plus the "c" keyboard shortcut, both
// opening a stay-open dialog that appends items to the inbox without leaving the current page.

test.describe('global quick capture', () => {
    test('FAB captures consecutive items from a non-inbox page', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `qc-fab-${dayjs().valueOf()}@example.com`, async (page) => {
            await page.goto('/next-actions');
            await page.getByTestId('quickCaptureFab').click();

            const input = page.getByTestId('quickCaptureInput');
            await input.fill('Buy milk');
            await input.press('Enter');
            await expect(page.getByTestId('quickCaptureCount')).toHaveText('1 captured');

            // Dialog stays open — the second thought needs no re-opening.
            await input.fill('Call the plumber');
            await input.press('Enter');
            await expect(page.getByTestId('quickCaptureCount')).toHaveText('2 captured');

            await page.getByTestId('quickCaptureClose').click();
            await expect(page.getByTestId('quickCaptureDialog')).toBeHidden();

            await gtd.flush(page);
            const items = await gtd.listItems(page);
            const titles = items.filter((i) => i.status === 'inbox').map((i) => i.title);
            expect(titles.sort()).toEqual(['Buy milk', 'Call the plumber']);
        });
    });

    test('the "c" shortcut opens the dialog; typing in a text field does not', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `qc-key-${dayjs().valueOf()}@example.com`, async (page) => {
            await page.goto('/someday');
            // Wait for hydration — the shortcut listener attaches when the FAB mounts.
            await expect(page.getByTestId('quickCaptureFab')).toBeVisible();
            await page.keyboard.press('c');
            await expect(page.getByTestId('quickCaptureDialog')).toBeVisible();

            // Inside the dialog's own text field, "c" is content — a second dialog must not stack.
            const input = page.getByTestId('quickCaptureInput');
            await input.fill('collect chairs');
            await expect(input).toHaveValue('collect chairs');

            await page.keyboard.press('Escape');
            await expect(page.getByTestId('quickCaptureDialog')).toBeHidden();

            // On the inbox page the capture field is auto-focused on mount — "c" typed there must
            // not open the dialog either.
            await page.goto('/inbox');
            const captureField = page.getByPlaceholder("What's on your mind?");
            await expect(captureField).toBeFocused();
            await page.keyboard.press('c');
            await expect(page.getByTestId('quickCaptureDialog')).toBeHidden();
            await expect(captureField).toHaveValue('c');
        });
    });

    test('markdown notes + draft: typed text survives close and reload; capture commits and clears', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `qc-draft-${dayjs().valueOf()}@example.com`, async (page) => {
            await page.goto('/someday');
            await page.getByTestId('quickCaptureFab').click();
            await page.getByTestId('quickCaptureInput').fill('Draft me');
            await page.getByTestId('quickCaptureAddNoteButton').click();
            await page.getByRole('textbox', { name: 'Notes (Markdown)' }).fill('- a **bold** point');
            // Wait for BOTH fields to reach IDB before navigating — title and notes land in
            // separate debounce commits, and a reload that beats the notes commit restores a
            // title-only draft (notes panel closed). See inbox-capture-draft.spec.ts.
            await expect
                .poll(async () =>
                    (await readDrafts(page)).map((draft) => ({
                        kind: draft.kind,
                        title: 'title' in draft ? draft.title : '',
                        notes: 'notes' in draft ? draft.notes : '',
                    })),
                )
                .toEqual([{ kind: 'quickCapture', title: 'Draft me', notes: '- a **bold** point' }]);

            // Done keeps the draft; reopening restores both fields and re-opens the notes panel.
            await page.getByTestId('quickCaptureClose').click();
            await page.getByTestId('quickCaptureFab').click();
            await expect(page.getByTestId('quickCaptureInput')).toHaveValue('Draft me');
            await expect(page.getByRole('textbox', { name: 'Notes (Markdown)' })).toHaveText('- a **bold** point');

            // Survives a full reload too.
            await page.goto('/someday');
            await expect(page.getByTestId('quickCaptureFab')).toBeVisible();
            await page.keyboard.press('c');
            await expect(page.getByTestId('quickCaptureInput')).toHaveValue('Draft me');
            await expect(page.getByRole('textbox', { name: 'Notes (Markdown)' })).toHaveText('- a **bold** point');

            // Capture commits the item WITH the markdown notes and clears the draft.
            await page.getByTestId('quickCaptureSubmit').click();
            await expect(page.getByTestId('quickCaptureCount')).toHaveText('1 captured');
            await expect.poll(async () => (await readDrafts(page)).length).toBe(0);

            await gtd.flush(page);
            const items = await gtd.listItems(page);
            const captured = items.find((item) => item.title === 'Draft me');
            expect(captured?.status).toBe('inbox');
            expect(captured?.notes).toBe('- a **bold** point');
        });
    });
});
