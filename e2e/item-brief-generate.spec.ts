import { expect, type Locator, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice, withTwoLoggedInDevices } from './helpers/context';
import { gtd } from './helpers/gtd';

// The on-demand "Generate brief" button (sparkle) in the item editor and on the weekly-review
// card. Playwright starts the API server with BRIEF_FAKE_MODEL=1, so the model is a deterministic
// stand-in: `[fake] <first sentence of the notes>`, and notes shorter than 160 chars come back as
// a `skipped` outcome (a stored `text: null` row) instead of a brief.

const FIRST_SENTENCE = 'Renewal form is half filled in — the personal details section is done but the travel history page is still blank';
const LONG_NOTES = [
    `${FIRST_SENTENCE}.`,
    'Need two new passport photos (the old ones are more than six months old) and the previous passport for the appointment.',
    'The June trip is the hard deadline; processing is quoted at four to six weeks, so this has to go in by early May at the latest.',
    'Payment can be made online once the form is submitted; keep the receipt for the expense claim.',
].join(' ');
const FAKE_BRIEF = `[fake] ${FIRST_SENTENCE}`;
const SHORT_NOTES = 'Call the clinic and ask for the earliest slot.';

function briefInputOf(scope: Page | Locator) {
    return scope.getByTestId('briefField').getByRole('textbox', { name: 'Brief' });
}

test.describe('item brief — generated on demand', () => {
    test('Generate writes a model brief that the field shows and a second device receives; Regenerate over a typed brief asks first', async ({ browser }) => {
        const email = `brief-generate-${dayjs().valueOf()}@example.com`;
        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            const captured = await gtd.collect(page1, 'Renew passport');
            const item = await gtd.updateItem(page1, { ...captured, notes: LONG_NOTES });
            expect(LONG_NOTES.length).toBeGreaterThanOrEqual(400);
            await gtd.flush(page1); // never navigate mid-flush — see clarify-to-routine.spec.ts

            await page1.goto(`/item/${item._id}`);
            const briefInput = briefInputOf(page1);
            await expect(briefInput).toHaveValue('');
            const generateButton = page1.getByTestId('briefGenerateButton');
            await expect(generateButton).toHaveAccessibleName('Generate brief');

            // (1) Generate → the field fills with the fake model's line; the stored row is model-origin.
            await generateButton.click();
            await expect(briefInput).toHaveValue(FAKE_BRIEF, { timeout: 15_000 });
            await expect(page1.getByTestId('briefReplaceConfirm')).toHaveCount(0);
            const generated = await gtd.getItemBrief(page1, item._id);
            expect(generated?.origin).toBe('model');
            expect(generated?.text).toBe(FAKE_BRIEF);
            // Server-authored: the device queues nothing to push for it.
            expect((await gtd.queuedOps(page1)).filter((op) => op.entityType === 'itemBrief')).toHaveLength(0);
            // The button now offers to regenerate (a brief is on show).
            await expect(generateButton).toHaveAccessibleName('Regenerate brief');

            // The second device receives the same row through sync.
            await expect.poll(async () => (await gtd.getItemBrief(page2, item._id))?.text, { timeout: 15_000 }).toBe(FAKE_BRIEF);
            expect((await gtd.getItemBrief(page2, item._id))?.origin).toBe('model');

            // (2) Type a user brief over it (blur commits) → the row is pinned.
            await briefInput.fill('My own one-liner about the passport');
            await page1.getByRole('textbox', { name: 'Title' }).click();
            await expect.poll(async () => (await gtd.getItemBrief(page1, item._id))?.origin).toBe('user');
            await gtd.flush(page1);

            // Regenerate → inline confirm; Keep leaves the user brief untouched.
            await generateButton.click();
            const confirm = page1.getByTestId('briefReplaceConfirm');
            await expect(confirm).toBeVisible();
            await expect(confirm).toContainText('Replace your brief?');
            await page1.getByTestId('briefKeepButton').click();
            await expect(confirm).toHaveCount(0);
            await expect(briefInput).toHaveValue('My own one-liner about the passport');
            expect((await gtd.getItemBrief(page1, item._id))?.origin).toBe('user');

            // Replace → the fake line is back, model-origin again, on both devices.
            await generateButton.click();
            await page1.getByTestId('briefReplaceButton').click();
            await expect(briefInput).toHaveValue(FAKE_BRIEF, { timeout: 15_000 });
            await expect.poll(async () => (await gtd.getItemBrief(page1, item._id))?.origin).toBe('model');
            await expect.poll(async () => (await gtd.getItemBrief(page2, item._id))?.origin, { timeout: 15_000 }).toBe('model');
        });
    });

    test('the weekly-review card carries the button and leads with the generated brief', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `brief-generate-review-${dayjs().valueOf()}@example.com`, async (page) => {
            const captured = await gtd.collect(page, 'Renew passport');
            const item = await gtd.clarifyToNextAction(page, { ...captured, notes: LONG_NOTES }, {});
            await gtd.flush(page);

            await page.goto('/weekly-review?stage=nextActions');
            await page.getByTestId('startReviewButton').click();
            const card = page.getByTestId('focusStage');
            await expect(card.getByRole('textbox', { name: 'Title' })).toHaveValue('Renew passport');
            // No brief yet → the plain field (with the sparkle in its adornment) and the notes preview.
            await expect(briefInputOf(card)).toHaveValue('');
            await expect(card.getByTestId('pageNotesPreview')).toBeVisible();

            await card.getByTestId('briefGenerateButton').click();
            // Brief-first once the model row lands: the line replaces the field and the notes fold away.
            await expect(card.getByTestId('briefLine')).toHaveText(FAKE_BRIEF, { timeout: 15_000 });
            await expect(card.getByTestId('showNotesButton')).toBeVisible();
            await expect(card.getByTestId('briefReplaceConfirm')).toHaveCount(0);
            expect((await gtd.getItemBrief(page, item._id))?.origin).toBe('model');
            // The line variant keeps the button too (a regenerate is one click away).
            await expect(card.getByTestId('briefGenerateButton')).toHaveAccessibleName('Regenerate brief');
        });
    });

    test('notes typed moments before the click are what the brief is generated from (autosave is flushed first)', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `brief-generate-typed-${dayjs().valueOf()}@example.com`, async (page) => {
            // Seeded WITHOUT notes: a generate from the server's stale copy would come back `skipped`.
            const item = await gtd.collect(page, 'Renew passport');
            await gtd.flush(page);

            await page.goto(`/item/${item._id}`);
            // Empty notes render the CodeMirror editor as the resting state (no "Edit notes"
            // affordance to click), so type straight into it.
            const notesEditor = page.getByRole('textbox', { name: 'Notes (Markdown)' });
            await notesEditor.click();
            await expect(notesEditor).toBeFocused();
            await notesEditor.fill(LONG_NOTES);
            // Deliberately no blur and no gtd.flush: the 800 ms notes autosave is still pending.
            await page.getByTestId('briefGenerateButton').click();

            await expect(briefInputOf(page)).toHaveValue(FAKE_BRIEF, { timeout: 15_000 });
            const generated = await gtd.getItemBrief(page, item._id);
            expect(generated?.text).toBe(FAKE_BRIEF); // not a `skipped` row from the pre-typing notes
            expect(generated?.origin).toBe('model');
            await expect(page.getByTestId('briefGenerateNotice')).toHaveCount(0);
        });
    });

    test('short notes produce the "too short" notice and no brief line', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `brief-generate-short-${dayjs().valueOf()}@example.com`, async (page) => {
            const captured = await gtd.collect(page, 'Book dentist');
            const item = await gtd.updateItem(page, { ...captured, notes: SHORT_NOTES });
            expect(SHORT_NOTES.length).toBeLessThan(160);
            await gtd.flush(page);

            await page.goto(`/item/${item._id}`);
            await page.getByTestId('briefGenerateButton').click();
            await expect(page.getByTestId('briefGenerateNotice')).toContainText('Notes are too short for a brief — the title already says it', {
                timeout: 15_000,
            });
            await expect(briefInputOf(page)).toHaveValue('');
            await expect(page.getByTestId('briefLine')).toHaveCount(0);
            // The skip is recorded as a text-less row so the sweep will not keep retrying it.
            const skipped = await gtd.getItemBrief(page, item._id);
            expect(skipped?.origin).toBe('skipped');
            expect(skipped?.text).toBeNull();
        });
    });
});
