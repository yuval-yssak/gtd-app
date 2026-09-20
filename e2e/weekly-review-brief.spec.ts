import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Weekly-review presentation of item briefs: a review card with a brief on show leads with the
// brief line and folds the notes behind "Show notes"; the header's "Show briefs" switch restores
// the plain notes preview; editing the notes keeps a user-authored (pinned) brief with a stale
// marker. (A model-origin brief cannot be seeded from the client in Phase 1, so its flip to `none`
// is covered server-side only.)

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
            await expect(card.getByTestId('briefField').getByRole('textbox', { name: 'Brief' })).toHaveValue(
                'Passport before the June trip — photos are the blocker',
            );

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

    test('a card without a brief keeps the current notes preview (no disclosure, no brief line)', async ({ browser }) => {
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
            await expect(card.getByTestId('briefField').getByRole('textbox', { name: 'Brief' })).toHaveValue('');
        });
    });
});
