import { expect, test } from '@playwright/test';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { briefTextOf, openBriefEditor } from './helpers/itemEditorLocators';
import { uniqueStamp } from './helpers/uniqueStamp';

// The Pinned / Stale chips beside a brief. A model brief that the notes moved past still fills the
// field (its derived state is `none`), so without the Stale chip it read as current. Playwright
// runs the API with BRIEF_FAKE_MODEL=1: Generate writes `[fake] <first sentence of the notes>`.

const FIRST_SENTENCE = 'Renewal form is half filled in — the personal details section is done but the travel history page is still blank';
const LONG_NOTES = [
    `${FIRST_SENTENCE}.`,
    'Need two new passport photos (the old ones are more than six months old) and the previous passport for the appointment.',
    'The June trip is the hard deadline; processing is quoted at four to six weeks, so this has to go in by early May at the latest.',
].join(' ');
const FAKE_BRIEF = `[fake] ${FIRST_SENTENCE}`;

test.describe('item brief — Pinned and Stale labels', () => {
    test('a model brief turns Stale once the notes change; typing your own makes it Pinned and current', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `brief-labels-${uniqueStamp()}@example.com`, async (page) => {
            const captured = await gtd.collect(page, 'Renew passport');
            const item = await gtd.updateItem(page, { ...captured, notes: LONG_NOTES });
            await gtd.flush(page); // never navigate mid-flush — see clarify-to-routine.spec.ts

            await page.goto(`/item/${item._id}`);
            const pinnedLabel = page.getByTestId('briefPinnedLabel');
            const staleLabel = page.getByTestId('briefStaleLabel');

            // A freshly generated model brief carries no label at all.
            await page.getByTestId('briefGenerateButton').click();
            await expect(briefTextOf(page)).toHaveText(FAKE_BRIEF, { timeout: 15_000 });
            await expect(pinnedLabel).toHaveCount(0);
            await expect(staleLabel).toHaveCount(0);

            // Edit the notes: the model brief is still shown, now labelled Stale (not Pinned).
            // A brief on show folds the notes behind "Show notes" — expand them first.
            await page.getByTestId('showNotesButton').click();
            await page.getByRole('button', { name: 'Edit notes' }).click();
            const notesEditor = page.getByRole('textbox', { name: 'Notes (Markdown)' });
            await notesEditor.press('End');
            await notesEditor.pressSequentially(' Photos done.');
            await page.getByRole('textbox', { name: 'Title' }).click();
            await expect.poll(async () => (await gtd.listItems(page)).find((row) => row._id === item._id)?.notes).toContain('Photos done.');
            await expect(briefTextOf(page)).toHaveText(FAKE_BRIEF);
            await expect(staleLabel).toHaveText('Stale');
            await expect(pinnedLabel).toHaveCount(0);
            await staleLabel.hover();
            await expect(page.getByRole('tooltip')).toHaveText('The title or notes changed since this brief was written. It is refreshed automatically.');

            // Typing a brief pins it against the CURRENT notes: Pinned, and no longer Stale.
            const briefInput = await openBriefEditor(page);
            // The chips describe the stored row, so they step aside while the field is open.
            await expect(staleLabel).toHaveCount(0);
            await briefInput.fill('Passport before the June trip — photos are done');
            await page.getByRole('textbox', { name: 'Title' }).click();
            await expect.poll(async () => (await gtd.getItemBrief(page, item._id))?.origin).toBe('user');
            await expect(pinnedLabel).toHaveText('Pinned');
            await expect(staleLabel).toHaveCount(0);
            await pinnedLabel.hover();
            await expect(page.getByRole('tooltip')).toHaveText('You wrote this brief, so it is never rewritten automatically.');
        });
    });
});
