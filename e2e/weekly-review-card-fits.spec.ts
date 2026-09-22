import { expect, type Locator, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// A next action with no usable brief and multi-line notes used to overflow the weekly-review
// card: the reviewer could see down to the tickler field but not the work contexts, people,
// energy, urgency, focus or expected-by below it. The card is the full item editor, whose
// metadata rows each owned a full-width line however narrow the control was.
//
// The dense layout pairs those narrow controls into two columns, halves the section gap and
// drops the notes-preview height floor. This spec pins the outcome the user actually cares
// about — the whole item visible at once — rather than any one of those mechanisms.

// Four lines of notes at the reported card width, matching the reported item's shape.
const NOTES = ['- Benjamin', '- Nir', '- Primos', '- Yonatan'].join('\n');

/** The full-width wrapper that owns the stage's scroll (a sibling of the pinned action bar). */
const scrollerOf = (stage: Locator) => stage.getByTestId('stageCardScroller');

test.describe('Weekly review card fits without scrolling', () => {
    test('a next action with notes and no brief shows its metadata without scrolling', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `review-fits-${dayjs().valueOf()}@example.com`, async (page) => {
            // The reported display: 1920x929. The card's budget is viewport-height driven, so the
            // height is the part that matters — pin both so the assertion means something.
            await page.setViewportSize({ width: 1920, height: 929 });

            const context = await gtd.createWorkContext(page, 'anywhere');
            const inbox = await gtd.collect(page, 'Contact friends bi-weekly');
            await gtd.clarifyToNextAction(
                page,
                { ...inbox, notes: NOTES },
                { workContextIds: [context._id], energy: 'low', time: 15, expectedBy: dayjs().add(3, 'day').format('YYYY-MM-DD') },
            );
            await gtd.flush(page); // never navigate mid-flush — see clarify-to-routine.spec.ts

            await page.goto('/weekly-review?stage=nextActions');
            await page.getByTestId('startReviewButton').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Next Actions');

            const card = page.getByTestId('focusStage');
            // Precondition: no brief, so the tall variant renders (brief field + full notes
            // preview) — the exact case that overflowed.
            await expect(card.getByTestId('briefLine')).toHaveCount(0);

            // The last metadata control in the card. If anything above it still overflows, it is
            // pushed out of the scrollport and this fails.
            const expectedBy = card.getByLabel('Expected by');
            await expect(expectedBy).toBeVisible();
            await expect(expectedBy).toBeInViewport({ ratio: 1 });

            // …and nothing is scrolled: the whole item is on screen at once, which is the property
            // that "I need to scroll to see the full picture" is about. The full-width wrapper
            // around the card owns the scroll, so it is what proves the item fits.
            const overflow = await scrollerOf(card).evaluate((el) => el.scrollHeight - el.clientHeight);
            expect(overflow).toBeLessThanOrEqual(1);
        });
    });

    test('very long notes stay capped so the rest of the item keeps its place', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `review-longnotes-${dayjs().valueOf()}@example.com`, async (page) => {
            await page.setViewportSize({ width: 1920, height: 929 });

            // An inbox capture with runaway notes — the shape that still overflowed after the
            // density work, because the global notes ceiling is 60vh: at this height that is 557px
            // of a ~711px card, leaving too little for the status chips and the rest.
            const hugeNotes = Array.from({ length: 222 }, (_, i) => `note line ${i + 1}`).join('\n');
            const inbox = await gtd.collect(page, 'test 1');
            await gtd.updateItem(page, { ...inbox, notes: hugeNotes });
            await gtd.flush(page);

            await page.goto('/weekly-review?stage=clarify');
            await page.getByTestId('startReviewButton').click();

            const stage = page.getByTestId('clarifyStage');
            await expect(stage.getByRole('textbox', { name: 'Title' })).toHaveValue('test 1');

            // The notes surface scrolls internally rather than growing without bound...
            const notesHeight = await stage
                .locator('[class*="previewClickable"], [class*="cm-scroller"]')
                .first()
                .evaluate((el) => el.clientHeight);
            const viewportHeight = page.viewportSize()?.height ?? 0;
            expect(notesHeight).toBeLessThanOrEqual(viewportHeight * 0.35);

            // ...so the status chips below it — the whole point of the clarify stage — stay on screen.
            await expect(stage.getByRole('button', { name: 'Next Action' })).toBeInViewport({ ratio: 1 });
            const overflow = await scrollerOf(stage).evaluate((el) => el.scrollHeight - el.clientHeight);
            expect(overflow).toBeLessThanOrEqual(1);
        });
    });

    test('stepping back into an already-reviewed item keeps the review density', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `review-revisit-${dayjs().valueOf()}@example.com`, async (page) => {
            await page.setViewportSize({ width: 1920, height: 929 });

            // The revisit view renders the same editor for a real item. Without the review
            // presentation it falls back to the item PAGE's roomier layout (60vh notes, 1rem
            // gaps, the 7.5rem floor), so the long-notes overflow reappears one ◀ away.
            const hugeNotes = Array.from({ length: 222 }, (_, i) => `note line ${i + 1}`).join('\n');
            const inbox = await gtd.collect(page, 'revisited long notes');
            const action = await gtd.clarifyToNextAction(page, inbox, {});
            await gtd.updateItem(page, { ...action, notes: hugeNotes });
            await gtd.flush(page);

            await page.goto('/weekly-review?stage=nextActions');
            await page.getByTestId('startReviewButton').click();
            await page.getByTestId('focusKeep').click();
            await expect(page.getByTestId('stageEmptyCard')).toBeVisible();
            await page.getByTestId('stageNavBack').click();

            const revisit = page.getByTestId('revisitDecisionCard');
            await expect(revisit.getByTestId('revisitPositionLabel')).toBeVisible();

            // Assert the notes ceiling, not "no overflow at all": this item is long enough to
            // overflow the LIVE stage too (~54px there), so a zero-overflow assertion here would
            // be demanding something the review never promised. What the fix guarantees is that
            // revisit uses the review's 30vh ceiling rather than the item page's 60vh — the
            // difference between ~277px of notes and ~555px.
            const notesHeight = await revisit
                .locator('[class*="previewClickable"], [class*="cm-scroller"]')
                .first()
                .evaluate((el) => el.clientHeight);
            expect(notesHeight).toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) * 0.35);
        });
    });

    test('an empty stage keeps its card top reachable on a short viewport', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `review-short-${dayjs().valueOf()}@example.com`, async (page) => {
            // Landscape phone. The empty-state card centers in .centeredArea; plain `align-items:
            // center` would put its top at a NEGATIVE offset, which scrollTop (floored at 0) can
            // never reach — and with overflow:auto those pixels are clipped rather than painted.
            await page.setViewportSize({ width: 800, height: 380 });

            await page.goto('/weekly-review?stage=nextActions');
            await page.getByTestId('startReviewButton').click();

            const area = page.getByTestId('stageEmptyCard').locator('[class*="centeredArea"]');
            await expect(area).toBeVisible();
            const topOffset = await area.evaluate((el) => {
                const card = el.firstElementChild;
                if (!card) throw new Error('expected a card inside the centered area');
                return card.getBoundingClientRect().top - el.getBoundingClientRect().top;
            });
            expect(topOffset).toBeGreaterThanOrEqual(0);
        });
    });

    test('the inbox checklist scrolls from the gutters beside its card', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `review-checklist-${dayjs().valueOf()}@example.com`, async (page) => {
            // Short enough that the seeded buckets plus the ones added below overflow the stage.
            await page.setViewportSize({ width: 1280, height: 400 });

            await page.goto('/weekly-review');
            await page.getByTestId('startReviewButton').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Clear all inboxes');

            // Enough rows that the checklist is taller than the stage area.
            await page.getByTestId('manageInboxesButton').click();
            for (let i = 0; i < 12; i++) {
                await page.getByTestId('newInboxNameInput').fill(`Bucket ${i + 1}`);
                await page.getByTestId('addInboxButton').click();
            }
            await page.getByTestId('manageInboxesDone').click();

            // The WRAPPER must own the overflow, and the card must NOT scroll internally — a card
            // that keeps its own scroll leaves the gutters beside it dead, which is the bug this
            // stage's wrapper exists to fix. (Asserting only "the wrapper overflows" is too weak:
            // with the card scrolling, the wrapper still picks up a few stray pixels.)
            const scroller = scrollerOf(page.getByTestId('inboxChecklistStage'));
            const cardOverflow = () =>
                scroller.evaluate((el) => {
                    const card = el.firstElementChild;
                    if (!card) throw new Error('expected the checklist card inside the scroller');
                    return card.scrollHeight - card.clientHeight;
                });
            await expect.poll(async () => scroller.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100);
            expect(await cardOverflow()).toBe(0);

            const box = await scroller.boundingBox();
            if (!box) throw new Error('expected the scroller to have a box');
            const cardWidth = await scroller
                .locator('> *')
                .first()
                .evaluate((el) => el.getBoundingClientRect().width);
            await page.mouse.move(box.x + (box.width - cardWidth) / 4, box.y + box.height / 2);
            await page.mouse.wheel(0, 300);

            await expect.poll(async () => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        });
    });

    test('scrolling with the pointer in the side margin scrolls the review content', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `review-margin-${dayjs().valueOf()}@example.com`, async (page) => {
            await page.setViewportSize({ width: 1920, height: 929 });

            // Long enough to overflow even the dense card, so there is something to scroll. A very
            // long title is what reliably grows the card: it wraps (multiline, no clamp), whereas
            // notes cap at 60vh inside their own scroller.
            const tallTitle = Array.from({ length: 30 }, (_, i) => `segment ${i + 1} of a deliberately long title`).join(' ');
            const inbox = await gtd.collect(page, tallTitle);
            await gtd.clarifyToNextAction(page, { ...inbox, notes: 'Short note' }, {});
            await gtd.flush(page);

            await page.goto('/weekly-review?stage=nextActions');
            await page.getByTestId('startReviewButton').click();
            const card = page.getByTestId('focusStage');
            await expect(card.locator('[class*="editorCard"]')).toBeVisible();

            // Precondition: the content really does overflow, otherwise a scroll proves nothing.
            const scroller = scrollerOf(card);
            const box = await scroller.boundingBox();
            if (!box) throw new Error('expected the scroller to have a box');
            await expect.poll(async () => scroller.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);

            // The gutter beside the 44rem card, well clear of its edge — the dead zone the user hit.
            const cardWidth = await card.locator('[class*="editorCard"]').evaluate((el) => el.getBoundingClientRect().width);
            const marginX = box.x + (box.width - cardWidth) / 4;
            await page.mouse.move(marginX, box.y + box.height / 2);
            await page.mouse.wheel(0, 400);

            await expect.poll(async () => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        });
    });
});
