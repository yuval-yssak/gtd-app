import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { briefInputOf } from './helpers/itemEditorLocators';

// Weekly-review presentation of item briefs: a review card with a brief on show leads with the
// brief line and folds the notes behind "Show notes"; the header's "Show briefs" switch restores
// the plain notes preview; editing the notes keeps a user-authored (pinned) brief with a stale
// marker. The `declined` state (a text-less row) is covered both ways: a `skipped` row arises
// naturally from the review-start sweep on short notes, and a `model` row is seeded through
// `gtd.seedDeclinedBrief` and asserted on the item page. A model brief's flip to `none` on a
// notes edit is still covered server-side only.

const LONG_NOTES = [
    'Renewal form is half filled in — the personal details section is done but the travel history page is still blank.',
    'Need two new passport photos (the old ones are more than six months old) and the previous passport for the appointment.',
    'The June trip is the hard deadline; processing is quoted at four to six weeks, so this has to go in by early May at the latest.',
    'Payment can be made online once the form is submitted; keep the receipt for the expense claim.',
].join(' ');

test.describe('weekly review — briefs', () => {
    test('brief-first card, Show notes disclosure, header toggle, and the stale marker after a notes edit', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-brief-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Renew passport');
            const item = await gtd.clarifyToNextAction(page, { ...inbox, notes: LONG_NOTES }, {});
            expect(LONG_NOTES.length).toBeGreaterThanOrEqual(400);
            await gtd.setUserBrief(page, item, 'Passport before the June trip — photos are the blocker');
            await gtd.flush(page); // never navigate mid-flush — see clarify-to-routine.spec.ts

            await page.goto('/weekly-review?stage=nextActions');
            await page.getByTestId('startReviewButton').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Next Actions');
            const card = page.getByTestId('focusStage');
            await expect(card.getByRole('textbox', { name: 'Title' })).toHaveValue('Renew passport');

            // Brief-first: the brief reads as a line right under the title; the notes preview is
            // folded behind a disclosure instead of rendering its (capped) Markdown preview.
            const briefLine = card.getByTestId('briefLine');
            await expect(briefLine).toHaveText('Passport before the June trip — photos are the blocker');
            await expect(card.getByTestId('briefStaleMarker')).toHaveCount(0);
            await expect(card.getByTestId('pageNotesPreview')).toHaveCount(0);
            const showNotes = card.getByTestId('showNotesButton');
            await expect(showNotes).toBeVisible();
            // DOM order pins "title → brief → the rest": the brief line precedes the disclosure.
            const briefBeforeNotes = await card.evaluate((cardEl) => {
                const line = cardEl.querySelector('[data-testid="briefLine"]');
                const button = cardEl.querySelector('[data-testid="showNotesButton"]');
                return Boolean(line && button && line.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING);
            });
            expect(briefBeforeNotes).toBe(true);

            // Expanding in place reveals the normal notes preview under the brief.
            await showNotes.click();
            await expect(card.getByTestId('pageNotesPreview')).toContainText('Renewal form is half filled in');
            await expect(card.getByTestId('briefLine')).toBeVisible();

            // Header "Show briefs" off → plain editor: the notes preview is back without a
            // disclosure and the brief renders as its ordinary field. The full header is one
            // strip-tap away in item stages.
            await page.getByTestId('reviewHeaderStrip').click();
            await page.getByTestId('showBriefsToggle').click();
            await expect(card.getByTestId('showNotesButton')).toHaveCount(0);
            await expect(card.getByTestId('pageNotesPreview')).toBeVisible();
            await expect(card.getByTestId('briefLine')).toHaveCount(0);
            await expect(briefInputOf(card)).toHaveValue('Passport before the June trip — photos are the blocker');

            // Toggle back on → brief-first again (the preference is live, no reload needed). The
            // notes stay expanded: the disclosure was already opened on this card, and expanding is
            // sticky for the card's lifetime.
            await page.getByTestId('showBriefsToggle').click();
            await expect(card.getByTestId('briefLine')).toBeVisible();
            await expect(card.getByTestId('pageNotesPreview')).toBeVisible();
            await expect(card.getByTestId('showNotesButton')).toHaveCount(0);

            // Edit the notes: a user-origin brief is PINNED — it stays on show, now with the
            // "notes changed" marker (a model brief would degrade to the notes preview instead).
            await card.getByRole('button', { name: 'Edit notes' }).click();
            const notesEditor = card.getByRole('textbox', { name: 'Notes (Markdown)' });
            await expect(notesEditor).toBeFocused();
            await notesEditor.press('End');
            await notesEditor.pressSequentially(' Photos done.');
            await card.getByRole('textbox', { name: 'Title' }).click();
            await expect.poll(async () => (await gtd.listItems(page)).find((row) => row._id === item._id)?.notes).toContain('Photos done.');
            await expect(card.getByTestId('briefLine')).toHaveText('Passport before the June trip — photos are the blocker');
            await expect(card.getByTestId('briefStaleMarker')).toHaveText('Notes changed since this brief was written');
        });
    });

    test('a card with no brief to show keeps the current notes preview (no disclosure, no brief line)', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-nobrief-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Plain action');
            await gtd.clarifyToNextAction(page, { ...inbox, notes: 'Short notes, no brief.' }, {});
            await gtd.flush(page);

            await page.goto('/weekly-review?stage=nextActions');
            await page.getByTestId('startReviewButton').click();
            const card = page.getByTestId('focusStage');
            await expect(card.getByRole('textbox', { name: 'Title' })).toHaveValue('Plain action');
            await expect(card.getByTestId('pageNotesPreview')).toContainText('Short notes, no brief.');
            await expect(card.getByTestId('showNotesButton')).toHaveCount(0);
            await expect(card.getByTestId('briefLine')).toHaveCount(0);
            // The brief field is still there to author one.
            await expect(briefInputOf(card)).toHaveValue('');
            // Opening the review runs the review-start sweep, which writes a `skipped` row for
            // these short notes — so this card ends up `declined`, worded for that origin. Either
            // way there is no brief LINE and the layout is not brief-first; that is what this
            // test pins. (The race between the sweep's write and the first render is why the
            // caption is polled rather than asserted at a single instant.)
            await expect.poll(async () => (await gtd.getItemBrief(page, inbox._id))?.origin, { timeout: 15_000 }).toBe('skipped');
            await expect(card.getByTestId('briefDeclinedNote')).toHaveText('No brief — the title already says it');
        });
    });

    // A text-less brief row (`origin: 'model'`, `text: null`) is the server saying "I read these
    // notes and there is nothing worth condensing". Before `declined` existed it rendered exactly
    // like "no brief at all" — an empty field the user could not tell from a broken feature.
    test('a declined brief explains itself, keeps the notes preview, and yields to the first keystroke', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-declined-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'test 1');
            const item = await gtd.clarifyToNextAction(page, { ...inbox, notes: LONG_NOTES }, {});
            // The text-less row a real model produced for the user: long notes, nothing worth
            // condensing. Seeded rather than generated — under BRIEF_FAKE_MODEL=1 the fake model
            // always returns text. Asserted on the item page, which renders the same BriefSection
            // in `edit` presentation and (unlike the review) runs no start-sweep that would
            // regenerate over an IDB-only row.
            const seeded = await gtd.seedDeclinedBrief(page, item, 'model');
            expect(seeded).toMatchObject({ origin: 'model', text: null });
            await gtd.flush(page); // never navigate mid-flush — see clarify-to-routine.spec.ts

            await page.goto(`/item/${item._id}`);
            await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('test 1');

            // The caption stands in for the empty field, and there is no brief LINE to lead with.
            await expect(page.getByTestId('briefDeclinedNote')).toHaveText('No brief — nothing in the notes to summarise');
            await expect(page.getByTestId('briefLine')).toHaveCount(0);
            await expect(page.getByTestId('briefStaleMarker')).toHaveCount(0);
            // The Generate button stays available so the user can retry after editing the notes.
            await expect(page.getByTestId('briefGenerateButton')).toBeEnabled();

            // Typing their own brief clears the caption on the FIRST keystroke — before any blur,
            // commit or save; the stored row is still the text-less one at that instant.
            const field = briefInputOf(page);
            await expect(field).toHaveValue('');
            await field.click();
            // Focus alone keeps the caption: with nothing typed it still reads as a hint.
            await expect(page.getByTestId('briefDeclinedNote')).toBeVisible();
            await field.pressSequentially('P');
            await expect(page.getByTestId('briefDeclinedNote')).toHaveCount(0);
            expect(await gtd.getItemBrief(page, item._id)).toMatchObject({ origin: 'model', text: null });

            // Backspacing to empty brings it back — the stored decision still stands.
            await field.press('Backspace');
            await expect(page.getByTestId('briefDeclinedNote')).toBeVisible();

            // Committing a real brief replaces the declined row with a pinned user one for good.
            await field.pressSequentially('Photos are the blocker');
            await page.getByRole('textbox', { name: 'Title' }).click();
            await expect.poll(async () => (await gtd.getItemBrief(page, item._id))?.text).toBe('Photos are the blocker');
            expect(await gtd.getItemBrief(page, item._id)).toMatchObject({ origin: 'user' });
            await expect(page.getByTestId('briefDeclinedNote')).toHaveCount(0);
        });
    });

    // The decision is scoped to the text it was made about: once the notes move on it lapses to
    // `none` so the next sweep reconsiders, rather than asserting "nothing to summarise" about
    // text the model never read.
    test('a declined brief lapses when the notes move on, and the caption goes with it', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-lapse-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'test 2');
            const item = await gtd.clarifyToNextAction(page, { ...inbox, notes: LONG_NOTES }, {});
            await gtd.seedDeclinedBrief(page, item, 'model');
            await gtd.flush(page);

            await page.goto(`/item/${item._id}`);
            await expect(page.getByTestId('briefDeclinedNote')).toBeVisible();

            // Non-empty notes rest as a preview; the editor opens behind "Edit notes".
            await page.getByRole('button', { name: 'Edit notes' }).click();
            const notesEditor = page.getByRole('textbox', { name: 'Notes (Markdown)' });
            await expect(notesEditor).toBeFocused();
            await notesEditor.press('End');
            await notesEditor.pressSequentially(' And one more thing worth noting.');
            await page.getByRole('textbox', { name: 'Title' }).click();
            await expect.poll(async () => (await gtd.listItems(page)).find((row) => row._id === item._id)?.notes).toContain('one more thing');

            await expect(page.getByTestId('briefDeclinedNote')).toHaveCount(0);
            // The row is untouched — only its hash no longer matches, which is what lapses it.
            expect(await gtd.getItemBrief(page, item._id)).toMatchObject({ origin: 'model', text: null });
        });
    });
});
