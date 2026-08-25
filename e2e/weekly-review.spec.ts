import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withOneLoggedInDevice, withTwoAccountsOnOneDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Weekly Review wizard: guided multi-step flow — inbox checklist (system + seeded user-defined
// buckets), solo clarify, solo focus stages with a linear skip-past walk, whole-stage skip, quick capture
// mid-review feeding the final sweep, and the confetti celebration at the end.

test.describe('weekly review', () => {
    test('full guided review: checklist → solo stages → mid-review capture → celebration', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-full-${dayjs().valueOf()}@example.com`, async (page) => {
            const loose = await gtd.collect(page, 'Loose thought');
            const action = await gtd.collect(page, 'Call Bob');
            await gtd.clarifyToNextAction(page, action, {});
            const someday = await gtd.collect(page, 'Learn woodworking');
            await gtd.clarifyToSomedayMaybe(page, someday, {});
            await gtd.flush(page); // never navigate mid-flush — see clarify-to-routine.spec.ts

            await page.goto('/weekly-review');
            await page.getByTestId('startReviewButton').click();

            // Stage 1 — checklist: system inbox + the three seeded starter buckets. The URL
            // mirrors the stage from the first moment.
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Clear all inboxes');
            await expect(page).toHaveURL(/stage=clearInboxes/);
            await expect(page.getByTestId('reviewInboxRow')).toHaveCount(3);
            await expect(page.getByTestId('stageContinue')).toBeDisabled();
            // Stage-travel arrows bracket the pinned bar on EVERY stage: ▶ moves on even while the
            // checklist is unticked (a plain jump — no skip mark), ◀ returns; ◀ is disabled on the
            // first stage.
            await expect(page.getByTestId('stageTravelPrev')).toBeDisabled();
            await page.getByTestId('stageTravelNext').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Clarify');
            await page.getByTestId('stageTravelPrev').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Clear all inboxes');
            await page.getByTestId('systemInboxTick').click();
            for (let i = 0; i < 3; i++) {
                await page.getByTestId('reviewInboxRow').nth(i).click();
            }
            await page.getByTestId('stageContinue').click();

            // Stage 2 — clarify the inbox item solo (full editor, one item at a time).
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Clarify');
            await expect(page).toHaveURL(/stage=clarify/);
            const clarifyStage = page.getByTestId('clarifyStage');
            await expect(clarifyStage.getByRole('textbox', { name: 'Title' })).toHaveValue('Loose thought');
            // The item's ID is visible in the editor and copiable to the clipboard.
            await expect(page.getByTestId('itemEditorId')).toContainText(loose._id);
            await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
            await page.getByTestId('copyItemIdButton').click();
            expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(loose._id);
            // Escape must NOT consume the item as a review decision — it steps PAST it: the walk
            // is linear, so the single item lands on the end card with the skip called out and the
            // processed counter still 0. ◀ steps back to it. Escape is pressed from INSIDE the
            // title field (which has no testid of its own): the recorded disconnection sentinel is
            // the card container, so focus still lands on the end card's primary, not <body>.
            await clarifyStage.getByRole('textbox', { name: 'Title' }).click();
            await page.keyboard.press('Escape');
            await expect(page.getByTestId('stageEmptyCard')).toContainText('Inbox — 1 skipped');
            await expect(page.getByTestId('stageContinue')).toBeFocused();
            await expect(page.getByTestId('reviewStageCounter')).toContainText('0 of 1');
            await page.getByTestId('stageNavBack').click();
            await expect(clarifyStage.getByRole('textbox', { name: 'Title' })).toHaveValue('Loose thought');
            await clarifyStage.getByRole('button', { name: 'Done', exact: true }).click();
            await page.getByTestId('clarifySaveNext').click();
            // Focus survives the transition: the clicked primary unmounted with the editor, so
            // its equivalent — the end card's Continue — takes it instead of <body>.
            await expect(page.getByTestId('stageContinue')).toBeFocused();
            await page.getByTestId('stageContinue').click();

            // Stage 3 — calendar: nothing scheduled. Continue kept focus across the stage change,
            // so an empty stage advances by keyboard alone.
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Calendar');
            await expect(page.getByTestId('stageContinue')).toBeFocused();
            await page.keyboard.press('Enter');

            // Stage 4 — next actions: solo card hosts the FULL editor; a skip walks to the END
            // (never back around), and ◀ recovers it.
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Next Actions');
            const focusStage = page.getByTestId('focusStage');
            await expect(focusStage.getByRole('textbox', { name: 'Title' })).toHaveValue('Call Bob');
            // Entering an item stage: Continue doesn't exist here, so focus lands on the card's
            // primary ("Looks good") — the fallback keeps the keyboard flow alive.
            await expect(page.getByTestId('focusKeep')).toBeFocused();
            // ◀ disabled — nothing skipped or decided in this stage yet.
            await expect(page.getByTestId('stageNavBack')).toBeDisabled();
            await page.getByTestId('stageNavForward').click();
            await expect(page.getByTestId('stageEmptyCard')).toContainText('Next Actions — 1 skipped');
            await page.getByTestId('stageNavBack').click();
            await expect(focusStage.getByRole('textbox', { name: 'Title' })).toHaveValue('Call Bob');
            // Untouched item → the primary reads "Looks good" and advances without a write.
            await expect(page.getByTestId('focusKeep')).toHaveText('Looks good');
            await page.getByTestId('focusKeep').click();
            await expect(page.getByTestId('stageEmptyCard')).toContainText('Next Actions — all reviewed!');
            await page.getByTestId('stageContinue').click();

            // Stage 5 — waiting for: skip the whole stage via the header control.
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Waiting For');
            await page.getByTestId('skipStageButton').click();

            // Stage 6 — tickler: empty. The header's Skip control persisted across the stage swap
            // (it never unmounts), so focus simply stays on it — no restoration involved.
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Tickler');
            await expect(page.getByTestId('skipStageButton')).toBeFocused();
            await page.getByTestId('stageContinue').click();

            // Stage 7 — someday/maybe: trash the parked item. Capture a fresh thought mid-review
            // through the global FAB — it must land in the final sweep.
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Someday / Maybe');
            await page.getByTestId('quickCaptureFab').click();
            await page.getByTestId('quickCaptureInput').fill('Mid-review idea');
            await page.getByTestId('quickCaptureInput').press('Enter');
            await page.getByTestId('quickCaptureClose').click();
            await expect(page.getByTestId('focusStage').getByRole('textbox', { name: 'Title' })).toHaveValue('Learn woodworking');
            await page.getByTestId('focusTrash').click();
            await page.getByTestId('stageContinue').click();

            // Stage 8 — final sweep: the mid-review capture comes around for clarifying. Travel ▶
            // is disabled on the last stage — finishing the review stays behind Continue.
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Final sweep');
            // Entering a clarify item stage: the fallback lands on ITS primary — pins
            // 'clarifySaveNext' as a real rendered testid in the primary chain.
            await expect(page.getByTestId('clarifySaveNext')).toBeFocused();
            await expect(page.getByTestId('stageTravelNext')).toBeDisabled();
            const sweepStage = page.getByTestId('clarifyStage');
            await expect(sweepStage.getByRole('textbox', { name: 'Title' })).toHaveValue('Mid-review idea');
            await sweepStage.getByRole('button', { name: 'Done', exact: true }).click();
            await page.getByTestId('clarifySaveNext').click();
            await page.getByTestId('stageContinue').click();

            // Celebration: confetti moment + per-stage stats + "mind is clear" payoff.
            await expect(page.getByTestId('reviewCelebration')).toBeVisible();
            await expect(page.getByTestId('reviewCelebration')).toContainText('Your mind is clear');
            await expect(page.getByTestId('reviewStats')).toContainText('Clarify: 1 reviewed');
            await expect(page.getByTestId('reviewStats')).toContainText('Next Actions: 1 reviewed');
            // The celebration replaced the whole wizard — its Done seeds focus (autoFocus) so the
            // keyboard flow ends on the button that exits the review.
            await expect(page.getByTestId('celebrationDone')).toBeFocused();
            await page.getByTestId('celebrationDone').click();
            // Done leaves the review page for the app's entry point (/ redirects to the inbox).
            await expect(page).toHaveURL(/\/inbox/);
            await gtd.flush(page); // never navigate mid-flush — see clarify-to-routine.spec.ts
            await page.goto('/weekly-review');
            await expect(page.getByTestId('lastCompletedLabel')).toBeVisible();

            const inboxes = await gtd.listReviewInboxes(page);
            expect(inboxes.map((inbox: { name: string }) => inbox.name)).toEqual(['Email', 'Physical In Tray', 'Voice recordings']);
            const items = await gtd.listItems(page);
            expect(items.find((i) => i._id === loose._id)?.status).toBe('done');
            expect(items.find((i) => i._id === someday._id)?.status).toBe('trash');
            expect(items.find((i) => i.title === 'Mid-review idea')?.status).toBe('done');
        });
    });

    test('an interrupted review resumes on reload with progress intact', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-resume-${dayjs().valueOf()}@example.com`, async (page) => {
            await page.goto('/weekly-review');
            await page.getByTestId('startReviewButton').click();
            await expect(page.getByTestId('reviewInboxRow')).toHaveCount(3);
            // Advance past stage 1 so resume proves the STAGE was restored (stage 1 is also what a
            // broken fresh start would render — the tick alone wouldn't discriminate).
            await page.getByTestId('systemInboxTick').click();
            for (let i = 0; i < 3; i++) {
                await page.getByTestId('reviewInboxRow').nth(i).click();
            }
            await page.getByTestId('stageContinue').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Clarify');
            // Draft writes are fire-and-forget; the flush drains the seed ops before the reload.
            await gtd.flush(page);

            await page.goto('/weekly-review');
            await expect(page.getByTestId('resumeReviewButton')).toBeVisible();
            await expect(page.getByTestId('startReviewButton')).toHaveCount(0);
            await page.getByTestId('resumeReviewButton').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Clarify');
            await expect(page).toHaveURL(/stage=clarify/);
        });
    });

    test('decision buttons stay pinned at one screen position: long items scroll inside their card, empty-stage Continue lands in the same bar', async ({
        browser,
    }) => {
        await withOneLoggedInDevice(browser, `wr-pinned-${dayjs().valueOf()}@example.com`, async (page) => {
            // One item long enough to force internal scrolling, one short — the action bar must
            // not move between them, and the page itself must never scroll.
            const longNotes = Array.from({ length: 120 }, (_, i) => `Note line ${i + 1}`).join('\n\n');
            const long = await gtd.collect(page, 'Long dossier');
            const longAction = await gtd.clarifyToNextAction(page, long, {});
            await gtd.updateItem(page, { ...longAction, notes: longNotes });
            const short = await gtd.collect(page, 'Short one');
            await gtd.clarifyToNextAction(page, short, {});
            await gtd.flush(page); // never navigate mid-flush — see clarify-to-routine.spec.ts

            // Deep-linked stage: start lands straight on Next Actions.
            await page.goto('/weekly-review?stage=nextActions');
            await page.getByTestId('startReviewButton').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Next Actions');

            const viewport = page.viewportSize();
            if (!viewport) throw new Error('expected a viewport');
            const focusStage = page.getByTestId('focusStage');
            const editorCardOverflow = () =>
                focusStage.evaluate((stage) => {
                    const card = stage.firstElementChild;
                    return card ? card.scrollHeight - card.clientHeight : -1;
                });

            // Item 1: primary button fully visible with zero scrolling, and living in the pinned
            // bar — NOT inside the scrolling editor card (pins the portal destination).
            await expect(focusStage.getByRole('textbox', { name: 'Title' })).toBeVisible();
            await expect(page.getByTestId('focusKeep')).toBeInViewport();
            await expect(page.getByTestId('stageActionBar').getByTestId('focusKeep')).toBeVisible();
            const barOnFirstItem = await page.getByTestId('stageActionBar').boundingBox();
            if (!barOnFirstItem) throw new Error('expected the action bar to render');
            expect(barOnFirstItem.y + barOnFirstItem.height).toBeLessThanOrEqual(viewport.height);
            const firstItemOverflow = await editorCardOverflow();
            // Portal ordering: portaled actions land in the content slot, LEFT of the ⏩ travel
            // arrow — a revert to portaling into the bar element itself would append them after it.
            const keepBox = await page.getByTestId('focusKeep').boundingBox();
            const travelNextBox = await page.getByTestId('stageTravelNext').boundingBox();
            const travelPrevBox = await page.getByTestId('stageTravelPrev').boundingBox();
            if (!keepBox || !travelNextBox || !travelPrevBox) throw new Error('expected primary and travel-arrow boxes');
            expect(keepBox.x + keepBox.width).toBeLessThanOrEqual(travelNextBox.x);
            // Symmetry: on a wide viewport the FAB reserve doesn't apply, so the travel arrows sit
            // equally far from their bar edges (the 5rem right padding is media-queried away).
            const leftGap = travelPrevBox.x - barOnFirstItem.x;
            const rightGap = barOnFirstItem.x + barOnFirstItem.width - (travelNextBox.x + travelNextBox.width);
            expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1);
            await page.getByTestId('focusKeep').click();

            // Item 2 (the other length): the bar has not moved a pixel.
            await expect(focusStage.getByRole('textbox', { name: 'Title' })).toBeVisible();
            const barOnSecondItem = await page.getByTestId('stageActionBar').boundingBox();
            expect(barOnSecondItem?.y).toBeCloseTo(barOnFirstItem.y, 0);
            const secondItemOverflow = await editorCardOverflow();
            // Discrimination guard: the long item genuinely overflowed its card (otherwise this
            // test would pass trivially with content that happens to fit).
            expect(Math.max(firstItemOverflow, secondItemOverflow)).toBeGreaterThan(0);
            // NOTHING outside the card scrolls — neither the layout container nor the document
            // (the document is what a stray in-flow element, e.g. a de-fixed FAB, would grow).
            const mainOverflow = await page.evaluate(() => {
                const main = document.querySelector('main');
                return main ? main.scrollHeight - main.clientHeight : -1;
            });
            expect(mainOverflow).toBeLessThanOrEqual(1);
            const docOverflow = await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight);
            expect(docOverflow).toBeLessThanOrEqual(1);
            // The bar is pinned to the SCREEN, not merely laid out last: scrolling must not move it.
            await page.evaluate(() => window.scrollTo(0, 99999));
            const barAfterScroll = await page.getByTestId('stageActionBar').boundingBox();
            expect(barAfterScroll?.y).toBeCloseTo(barOnFirstItem.y, 0);
            await page.getByTestId('focusKeep').click();

            // Empty state: Continue occupies the exact same pinned bar — the cursor never moves.
            await expect(page.getByTestId('stageEmptyCard')).toBeVisible();
            await expect(page.getByTestId('stageContinue')).toBeInViewport();
            const barOnEmpty = await page.getByTestId('stageActionBar').boundingBox();
            expect(barOnEmpty?.y).toBeCloseTo(barOnFirstItem.y, 0);

            // And across a stage switch (Waiting For, empty): same position again.
            await page.getByTestId('stageContinue').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Waiting For');
            const barOnNextStage = await page.getByTestId('stageActionBar').boundingBox();
            expect(barOnNextStage?.y).toBeCloseTo(barOnFirstItem.y, 0);

            // Narrow-desktop viewport (permanent 15rem sidebar, just above its 56.25rem
            // breakpoint): the FAB is fixed to the VIEWPORT while the bar centers in the content
            // column, so the reserve must still apply here — sidebar-blind breakpoint math once
            // dropped it and put the FAB over the primary button.
            await page.setViewportSize({ width: 960, height: 800 });
            const fabNarrow = await page.getByTestId('quickCaptureFab').boundingBox();
            const primaryNarrow = await page.getByTestId('stageContinue').boundingBox();
            if (!fabNarrow || !primaryNarrow) throw new Error('expected FAB and primary boxes at 960px');
            const narrowOverlap =
                fabNarrow.x < primaryNarrow.x + primaryNarrow.width &&
                primaryNarrow.x < fabNarrow.x + fabNarrow.width &&
                fabNarrow.y < primaryNarrow.y + primaryNarrow.height &&
                primaryNarrow.y < fabNarrow.y + fabNarrow.height;
            expect(narrowOverlap).toBe(false);

            // Mobile viewport: exercises the 9rem branch of --gtd-main-vertical-inset (fixed
            // AppBar + bottom nav) — bar in view, document scroll-free, scroll can't move it.
            const mobile = { width: 390, height: 844 };
            await page.setViewportSize(mobile);
            await expect(page.getByTestId('stageContinue')).toBeInViewport();
            const barOnMobile = await page.getByTestId('stageActionBar').boundingBox();
            if (!barOnMobile) throw new Error('expected the action bar on mobile');
            expect(barOnMobile.y + barOnMobile.height).toBeLessThanOrEqual(mobile.height);
            const mobileDocOverflow = await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight);
            expect(mobileDocOverflow).toBeLessThanOrEqual(1);
            await page.evaluate(() => window.scrollTo(0, 99999));
            const barOnMobileAfterScroll = await page.getByTestId('stageActionBar').boundingBox();
            expect(barOnMobileAfterScroll?.y).toBeCloseTo(barOnMobile.y, 0);

            // The fixed quick-capture FAB floats over the bar's right end on phones — the bar's
            // right padding must keep it clear of the primary button.
            const fab = await page.getByTestId('quickCaptureFab').boundingBox();
            const primary = await page.getByTestId('stageContinue').boundingBox();
            if (!fab || !primary) throw new Error('expected FAB and primary button boxes');
            const boxesOverlap =
                fab.x < primary.x + primary.width && primary.x < fab.x + fab.width && fab.y < primary.y + primary.height && primary.y < fab.y + fab.height;
            expect(boxesOverlap).toBe(false);
        });
    });

    test('next-actions stage walks items in the Next Actions page order (focus first, then expectedBy)', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-na-order-${dayjs().valueOf()}@example.com`, async (page) => {
            // Created oldest-first as plain → focus-later → focus-soon, so createdTs order would
            // present 'Plain undated' first — the page comparator must present 'Focus soon' first.
            const plain = await gtd.collect(page, 'Plain undated');
            await gtd.clarifyToNextAction(page, plain, {});
            const focusLater = await gtd.collect(page, 'Focus later');
            await gtd.clarifyToNextAction(page, focusLater, { focus: true, expectedBy: '2026-12-01' });
            const focusSoon = await gtd.collect(page, 'Focus soon');
            await gtd.clarifyToNextAction(page, focusSoon, { focus: true, expectedBy: '2026-09-01' });
            await gtd.flush(page); // never navigate mid-flush — see clarify-to-routine.spec.ts

            await page.goto('/weekly-review?stage=nextActions');
            await page.getByTestId('startReviewButton').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Next Actions');

            const focusStage = page.getByTestId('focusStage');
            await expect(focusStage.getByRole('textbox', { name: 'Title' })).toHaveValue('Focus soon');
            await page.getByTestId('focusKeep').click();
            await expect(focusStage.getByRole('textbox', { name: 'Title' })).toHaveValue('Focus later');
            await page.getByTestId('focusKeep').click();
            await expect(focusStage.getByRole('textbox', { name: 'Title' })).toHaveValue('Plain undated');
        });
    });

    test('items that become eligible mid-stage join the walk live: the total grows and the arrival is offered', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-live-append-${dayjs().valueOf()}@example.com`, async (page) => {
            const first = await gtd.collect(page, 'First thought');
            await gtd.flush(page); // never navigate mid-flush — see clarify-to-routine.spec.ts

            await page.goto('/weekly-review?stage=clarify');
            await page.getByTestId('startReviewButton').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Clarify');
            const clarifyStage = page.getByTestId('clarifyStage');
            await expect(clarifyStage.getByRole('textbox', { name: 'Title' })).toHaveValue('First thought');
            await expect(page.getByTestId('reviewStageCounter')).toContainText('0 of 1');

            // A capture made WHILE the stage is open joins the walk immediately — the total grows,
            // the current item stays put, and the arrival waits its turn at the end.
            await page.getByTestId('quickCaptureFab').click();
            await page.getByTestId('quickCaptureInput').fill('Fresh arrival');
            await page.getByTestId('quickCaptureInput').press('Enter');
            await page.getByTestId('quickCaptureClose').click();
            await expect(page.getByTestId('reviewStageCounter')).toContainText('0 of 2');
            await expect(clarifyStage.getByRole('textbox', { name: 'Title' })).toHaveValue('First thought');

            await clarifyStage.getByRole('button', { name: 'Done', exact: true }).click();
            await page.getByTestId('clarifySaveNext').click();
            await expect(clarifyStage.getByRole('textbox', { name: 'Title' })).toHaveValue('Fresh arrival');

            await gtd.flush(page);
            const items = await gtd.listItems(page);
            expect(items.find((i) => i._id === first._id)?.status).toBe('done');
        });
    });

    test('pre-celebration sweep: a finished stage that gained items re-offers them before the review ends', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-sweep-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.collect(page, 'Waiting seed');
            await gtd.flush(page); // never navigate mid-flush — see clarify-to-routine.spec.ts

            // Visit Waiting For while it is empty, then walk forward to the final sweep.
            await page.goto('/weekly-review?stage=waitingFor');
            await page.getByTestId('startReviewButton').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Waiting For');
            await page.getByTestId('stageContinue').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Tickler');
            await page.getByTestId('stageContinue').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Someday / Maybe');
            await page.getByTestId('stageContinue').click();

            // Final sweep: clarifying the capture INTO Waiting For plants an unseen item in a
            // stage that was already reviewed.
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Final sweep');
            const sweepStage = page.getByTestId('clarifyStage');
            await expect(sweepStage.getByRole('textbox', { name: 'Title' })).toHaveValue('Waiting seed');
            await sweepStage.getByRole('button', { name: 'Waiting For' }).click();
            await page.getByTestId('clarifySaveNext').click();
            await page.getByTestId('stageContinue').click();

            // Instead of the celebration: the sweep names the stale stage and re-offers it.
            await expect(page.getByTestId('sweepScreen')).toBeVisible();
            await expect(page.getByTestId('sweepStageRow')).toHaveText('Waiting For — 1 new item');
            await page.getByTestId('sweepReviewButton').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Waiting For');
            await expect(page.getByTestId('reviewStageCounter')).toContainText('0 of 1');
            await expect(page.getByTestId('focusStage').getByRole('textbox', { name: 'Title' })).toHaveValue('Waiting seed');
            await page.getByTestId('focusKeep').click();
            await page.getByTestId('stageContinue').click();

            // Walking forward from the revisit re-runs the completion check — clean now, so the
            // remaining empty stages lead straight into the celebration.
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Tickler');
            await page.getByTestId('stageContinue').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Someday / Maybe');
            await page.getByTestId('stageContinue').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Final sweep');
            await page.getByTestId('stageContinue').click();
            await expect(page.getByTestId('reviewCelebration')).toBeVisible();
        });
    });

    test('pre-celebration sweep: "Finish anyway" celebrates over the arrivals and deletes the draft', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-sweep-finish-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.collect(page, 'Skipped arrival');
            await gtd.flush(page); // never navigate mid-flush — see clarify-to-routine.spec.ts

            // Same shape as the sweep test: plant a waitingFor arrival behind a finished stage.
            await page.goto('/weekly-review?stage=waitingFor');
            await page.getByTestId('startReviewButton').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Waiting For');
            await page.getByTestId('stageContinue').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Tickler');
            await page.getByTestId('stageContinue').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Someday / Maybe');
            await page.getByTestId('stageContinue').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Final sweep');
            const sweepStage = page.getByTestId('clarifyStage');
            await sweepStage.getByRole('button', { name: 'Waiting For' }).click();
            await page.getByTestId('clarifySaveNext').click();
            await page.getByTestId('stageContinue').click();

            // Finishing anyway is a conscious skip: celebration renders, and the draft is gone —
            // a fresh visit offers Start, not Resume.
            await expect(page.getByTestId('sweepScreen')).toBeVisible();
            await page.getByTestId('sweepFinishButton').click();
            await expect(page.getByTestId('reviewCelebration')).toBeVisible();
            await page.getByTestId('celebrationDone').click();
            await expect(page).toHaveURL(/\/inbox/);
            await gtd.flush(page); // never navigate mid-flush — see clarify-to-routine.spec.ts
            await page.goto('/weekly-review');
            await expect(page.getByTestId('startReviewButton')).toBeVisible();
            await expect(page.getByTestId('resumeReviewButton')).toHaveCount(0);
            await expect(page.getByTestId('lastCompletedLabel')).toBeVisible();
        });
    });

    test('a mid-reassign item gets a working escape hatch: the pinned bar drops it past a single-item queue', async ({ browser }) => {
        const ts = dayjs().valueOf();
        const emailA = `wr-blocked-a-${ts}@example.com`;
        const emailB = `wr-blocked-b-${ts}@example.com`;
        // Unlike withOneLoggedInDevice, the two-account helper leaves the server reset to the
        // caller — without it the first pull 409s into the blocking "Full sync required" dialog.
        await resetServerForEmails([emailA, emailB]);
        await withTwoAccountsOnOneDevice(
            browser,
            [emailA, emailB],
            async (page, { secondary }) => {
                // Full sync pass first: registers the fresh device for BOTH accounts before any
                // mutation — collecting before bootstrap completes leaves the op stuck in the queue
                // and the reload lands in the "Full sync required" recovery dialog.
                await gtd.pull(page);
                const moving = await gtd.collect(page, 'Moving away');
                await gtd.clarifyToNextAction(page, moving, {});
                await gtd.flush(page); // never navigate mid-flush — see clarify-to-routine.spec.ts

                // Hold the reassign in flight until the test releases it.
                let releaseReassign = () => {};
                const reassignHeld = new Promise<void>((resolve) => {
                    releaseReassign = resolve;
                });
                await page.route('**/sync/reassign*', async (route) => {
                    // Hold only the POST — trapping the CORS preflight OPTIONS wedges the page's
                    // fetch entirely instead of keeping it pending.
                    if (route.request().method() !== 'POST') {
                        await route.continue();
                        return;
                    }
                    await reassignHeld;
                    await route.continue();
                });

                await page.goto('/weekly-review?stage=nextActions');
                await page.getByTestId('startReviewButton').click();
                await expect(page.getByTestId('reviewStageTitle')).toHaveText('Next Actions');

                // Owner change in the embedded editor → "Save & next" routes the save to a reassign.
                const focusStage = page.getByTestId('focusStage');
                await expect(focusStage.getByRole('textbox', { name: 'Title' })).toHaveValue('Moving away');
                await focusStage.getByTestId('accountPicker').click();
                await page.getByRole('option', { name: new RegExp(emailB) }).click();
                await expect(page.getByTestId('focusKeep')).toHaveText('Save & next');
                await page.getByTestId('focusKeep').click();

                // The reassign kickoff closes the editor as a SKIP (never a decision) — the walk
                // steps past the item onto the end card. ◀ returns to it: the editor early-returns
                // its in-flight notice (nothing portaled) and the bar offers exactly one
                // stage-owned Skip, which DROPS the blocked item out of the walk.
                await expect(page.getByTestId('stageEmptyCard')).toContainText('Next Actions — 1 skipped');
                await page.getByTestId('stageNavBack').click();
                await expect(page.getByTestId('focusBlockedSkip')).toBeVisible();
                await expect(page.getByTestId('focusBlockedSkip')).toHaveCount(1);
                await expect(page.getByTestId('focusKeep')).toHaveCount(0);
                await page.getByTestId('focusBlockedSkip').click();
                // Dropped without being counted as reviewed: the empty card says "nothing to
                // review" (stage-named, so it doesn't read as the whole review being done).
                await expect(page.getByTestId('stageEmptyCard')).toBeVisible();
                await expect(page.getByTestId('stageEmptyCard')).toContainText('Next Actions — nothing to review');

                // Release the held reassign; the move completes and its post-flight sync pass
                // lands the item on account B. Deliberately NO explicit gtd.pull here — a
                // concurrent orchestrated pull pivots the active Better Auth session mid-post-
                // flight and makes the reassign's own pull fail its session-match guard.
                const reassignResponse = page.waitForResponse((r) => r.url().includes('/sync/reassign') && r.request().method() === 'POST');
                releaseReassign();
                await reassignResponse;
                // Read the IDB row directly — gtd.listItems is active-account-scoped, and the item
                // now belongs to account B while A stays active.
                await expect
                    .poll(
                        async () =>
                            page.evaluate(async (id) => {
                                const g = (
                                    window as unknown as { __gtd: { db: { get(store: 'items', key: string): Promise<{ userId: string } | undefined> } } }
                                ).__gtd;
                                return (await g.db.get('items', id))?.userId;
                            }, moving._id),
                        { timeout: 15_000 },
                    )
                    .toBe(secondary.userId);
                // serviceWorkers: 'block' — once the PWA's SW controls the page, the routed
                // /sync/reassign request bypasses page.route and the in-flight hold never engages.
            },
            { serviceWorkers: 'block' },
        );
    });

    test('back arrow revisits decisions with one-click undo; text edits flip the primary to "Save & next"', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-undo-${dayjs().valueOf()}@example.com`, async (page) => {
            // Distinct expectedBy dates pin the walk order: undated same-tier items tie under the
            // Next Actions page comparator and would come up in arbitrary (IDB key) order.
            const first = await gtd.collect(page, 'First action');
            await gtd.clarifyToNextAction(page, first, { expectedBy: dayjs().add(7, 'day').format('YYYY-MM-DD') });
            const second = await gtd.collect(page, 'Second action');
            await gtd.clarifyToNextAction(page, second, { expectedBy: dayjs().add(8, 'day').format('YYYY-MM-DD') });
            await gtd.flush(page); // never navigate mid-flush — see clarify-to-routine.spec.ts

            await page.goto('/weekly-review?stage=nextActions');
            await page.getByTestId('startReviewButton').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Next Actions');

            // ▶ steps past an item (old "Skip for now") and ◀ steps back to it; past the last item
            // the walk ENDS on the stage-end card — it never cycles back to the beginning. The ◀
            // label is the only user-visible signal distinguishing un-skip from decision revisit.
            const focusStage = page.getByTestId('focusStage');
            const titleField = () => focusStage.getByRole('textbox', { name: 'Title' });
            await expect(titleField()).toHaveValue('First action');
            await page.getByTestId('stageNavForward').click();
            await expect(titleField()).toHaveValue('Second action');
            // The clicked ▶ was remounted with the new item's action row — focus stays on it, so
            // a keyboard user can keep stepping without re-tabbing.
            await expect(page.getByTestId('stageNavForward')).toBeFocused();
            await expect(page.getByTestId('stageNavBack')).toHaveAttribute('aria-label', 'Back to the skipped item');
            await page.getByTestId('stageNavForward').click();
            await expect(page.getByTestId('stageEmptyCard')).toContainText('Next Actions — 2 skipped');
            await page.getByTestId('stageNavBack').click();
            await expect(titleField()).toHaveValue('Second action');
            await page.getByTestId('stageNavBack').click();
            await expect(titleField()).toHaveValue('First action');
            await expect(page.getByTestId('stageNavBack')).toBeDisabled(); // back at the start, nothing decided

            // A text-only edit is acknowledged by the primary ("Save & next") even though the text
            // autosaves — clicking it advances, and the edit lands via the debounce/unmount flush.
            await titleField().fill('First action edited');
            await expect(page.getByTestId('focusKeep')).toHaveText('Save & next');
            await page.getByTestId('focusKeep').click();
            await expect(titleField()).toHaveValue('Second action');
            // With no skip behind the cursor, ◀ now offers decision revisit.
            await expect(page.getByTestId('stageNavBack')).toHaveAttribute('aria-label', 'Revisit previous decision');

            // Escape after the first item's autosave flush must STEP PAST (skip), not register as
            // a decision — the stale flush's onSaved once corrupted the saved marker this way. The
            // counter pins it: still 1 decided of 2.
            await page.keyboard.press('Escape');
            await expect(page.getByTestId('stageEmptyCard')).toContainText('Next Actions — 1 skipped');
            await expect(page.getByTestId('reviewStageCounter')).toContainText('1 of 2');
            await page.getByTestId('stageNavBack').click();
            await expect(titleField()).toHaveValue('Second action');

            // Mark Second done — the stage is exhausted, but ◀ stays reachable from "All reviewed!".
            await page.getByTestId('focusDone').click();
            await expect(page.getByTestId('stageEmptyCard')).toContainText('Next Actions — all reviewed!');
            await page.getByTestId('stageNavBack').click();

            // Revisiting the newest decision: full editor on the done item, with one-click undo.
            const revisit = page.getByTestId('revisitDecisionCard');
            await expect(page.getByTestId('revisitPositionLabel')).toHaveText('Already reviewed · 2 of 2');
            // Entering the revisit view is STAGE-LOCAL state (the wizard never re-renders, and the
            // revisit action row portals another child commit later) — the DOM-observer restore
            // must still land focus on the revisit view's own ◀.
            await expect(page.getByTestId('stageNavBack')).toBeFocused();
            await expect(revisit.getByRole('textbox', { name: 'Title' })).toHaveValue('Second action');
            await page.getByTestId('revisitUndoDecision').click();

            // Undo restores the pre-decision snapshot (done → nextAction) and returns the item to
            // the cursor position of the live queue as the regular editing page.
            await expect(titleField()).toHaveValue('Second action');
            await expect(page.getByTestId('focusKeep')).toBeVisible();
            // Leaving the revisit view via Undo unmounts the clicked button — the live card's
            // primary takes focus (via the transient end-card Continue while the requeue settles).
            await expect(page.getByTestId('focusKeep')).toBeFocused();
            await expect(page.getByTestId('reviewStageCounter')).toContainText('1 of 2');
            await expect.poll(async () => (await gtd.listItems(page)).find((i) => i._id === second._id)?.status).toBe('nextAction');

            // The remaining (snapshot-less) decision undoes too: the text-edited item was decided
            // without a write, so undo simply requeues it — at the cursor, ahead of Second.
            await page.getByTestId('stageNavBack').click();
            await expect(page.getByTestId('revisitPositionLabel')).toHaveText('Already reviewed · 1 of 1');
            await page.getByTestId('revisitUndoDecision').click();
            await expect(titleField()).toHaveValue('First action edited');
            await expect(page.getByTestId('reviewStageCounter')).toContainText('0 of 2');

            // Manual-fix path: decide First untouched again, revisit it, and flip its status chip —
            // the revisit Save commits in place (the decision stands, nothing is undone) and the
            // post-save close returns to the live queue.
            await expect(page.getByTestId('focusKeep')).toHaveText('Looks good'); // remount reset the text acknowledgement
            await page.getByTestId('focusKeep').click();
            await expect(titleField()).toHaveValue('Second action');
            await page.getByTestId('stageNavBack').click();
            const revisitAgain = page.getByTestId('revisitDecisionCard');
            await expect(page.getByTestId('revisitPositionLabel')).toHaveText('Already reviewed · 1 of 1');
            await expect(page.getByTestId('stageNavBack')).toBeDisabled(); // oldest decision — nowhere further back
            await expect(page.getByTestId('revisitSave')).toBeDisabled(); // nothing edited yet
            await revisitAgain.getByRole('button', { name: 'Someday / Maybe' }).click();
            await page.getByTestId('revisitSave').click();
            await expect(titleField()).toHaveValue('Second action');
            await expect(page.getByTestId('reviewStageCounter')).toContainText('1 of 2');
            await expect.poll(async () => (await gtd.listItems(page)).find((i) => i._id === first._id)?.status).toBe('somedayMaybe');

            // ▶ from a revisit walks forward, landing back on the live queue from the newest decision.
            await page.getByTestId('stageNavBack').click();
            await expect(page.getByTestId('revisitDecisionCard')).toBeVisible();
            await page.getByTestId('stageNavForward').click();
            await expect(page.getByTestId('focusStage')).toBeVisible();

            await gtd.flush(page);
            const items = await gtd.listItems(page);
            const firstFinal = items.find((i) => i._id === first._id);
            expect(firstFinal?.title).toBe('First action edited');
            expect(firstFinal?.status).toBe('somedayMaybe');
            expect(items.find((i) => i._id === second._id)?.status).toBe('nextAction');
        });
    });

    test('a clarify-to-routine decision offers no undo — the compound write cannot be snapshot-restored', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-routine-${dayjs().valueOf()}@example.com`, async (page) => {
            const capture = await gtd.collect(page, 'Water the plants');
            await gtd.flush(page); // never navigate mid-flush — see clarify-to-routine.spec.ts

            await page.goto('/weekly-review?stage=clarify');
            await page.getByTestId('startReviewButton').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Clarify');

            // Convert the capture into a routine right inside the review's clarify stage.
            const clarifyStage = page.getByTestId('clarifyStage');
            await expect(clarifyStage.getByRole('textbox', { name: 'Title' })).toHaveValue('Water the plants');
            await clarifyStage.getByRole('button', { name: 'Routine' }).click();
            await expect(clarifyStage.getByTestId('itemEditorRoutineFields')).toBeVisible();
            await page.getByTestId('clarifySaveNext').click();
            await expect(page.getByTestId('stageEmptyCard')).toContainText('Inbox clear!');

            // The decision is revisitable but NOT undoable: clarify-to-routine is a compound write
            // (new routine + seeded items + the capture trashed) — a bare snapshot restore would
            // resurrect the capture while leaving the created routine alive as a duplicate.
            await page.getByTestId('stageNavBack').click();
            await expect(page.getByTestId('revisitPositionLabel')).toHaveText('Already reviewed · 1 of 1');
            await expect(page.getByTestId('revisitUndoDecision')).toHaveCount(0);

            // The routine survives; the capture stayed consumed.
            await gtd.flush(page);
            const routines = await gtd.listRoutines(page);
            expect(routines).toHaveLength(1);
            const [routine] = routines;
            if (!routine) throw new Error('expected the created routine');
            expect(routine.title).toBe('Water the plants');
            // By id, not title — the routine immediately seeds a same-titled nextAction item.
            const items = await gtd.listItems(page);
            expect(items.find((i) => i._id === capture._id)?.status).toBe('trash');
        });
    });

    test('timeline stepper: free jumps sync the URL, revisits offer undecided + new items, inline edit saves', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-timeline-${dayjs().valueOf()}@example.com`, async (page) => {
            // Distinct expectedBy dates pin the walk order: undated same-tier items tie under the
            // Next Actions page comparator and would come up in arbitrary (IDB key) order.
            const first = await gtd.collect(page, 'First action');
            await gtd.clarifyToNextAction(page, first, { expectedBy: dayjs().add(7, 'day').format('YYYY-MM-DD') });
            const second = await gtd.collect(page, 'Second action');
            await gtd.clarifyToNextAction(page, second, { expectedBy: dayjs().add(8, 'day').format('YYYY-MM-DD') });
            await gtd.flush(page); // never navigate mid-flush — see clarify-to-routine.spec.ts

            await page.goto('/weekly-review');
            await page.getByTestId('startReviewButton').click();

            // Free forward jump straight to Next Actions (stage index 3) — no skip marks, URL follows.
            await page.getByTestId('reviewStepperStep').nth(3).click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Next Actions');
            await expect(page).toHaveURL(/stage=nextActions/);

            // Decide the first item untouched; the second gets an INLINE structural edit — the
            // status chip flips the primary from "Looks good" to "Save & next", which commits.
            const focusStage = page.getByTestId('focusStage');
            await expect(focusStage.getByRole('textbox', { name: 'Title' })).toHaveValue('First action');
            await page.getByTestId('focusKeep').click();
            await expect(focusStage.getByRole('textbox', { name: 'Title' })).toHaveValue('Second action');
            await focusStage.getByRole('button', { name: 'Someday / Maybe' }).click();
            await expect(page.getByTestId('focusKeep')).toHaveText('Save & next');
            // A structural edit must not vanish on a stage jump — the travel arrows lock while
            // the editor is dirty (the router-based unsaved-changes guard can never see this
            // state change, so an enabled arrow would silently drop the edit).
            await expect(page.getByTestId('stageTravelNext')).toBeDisabled();
            await expect(page.getByTestId('stageTravelPrev')).toBeDisabled();
            await page.getByTestId('focusKeep').click();
            await expect(page.getByTestId('stageEmptyCard')).toBeVisible();
            // The lock releases once the save committed and the editor unmounted.
            await expect(page.getByTestId('stageTravelNext')).toBeEnabled();

            // Capture a fresh thought from another stage, then revisit Clarify via the timeline:
            // the revisit queue holds exactly the new undecided item.
            await page.getByTestId('reviewStepperStep').nth(6).click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Someday / Maybe');
            await page.getByTestId('quickCaptureFab').click();
            await page.getByTestId('quickCaptureInput').fill('Mid-jump thought');
            await page.getByTestId('quickCaptureInput').press('Enter');
            await page.getByTestId('quickCaptureClose').click();
            await page.getByTestId('reviewStepperStep').nth(1).click();
            await expect(page.getByTestId('reviewStageCounter')).toContainText('0 of 1');
            await expect(page.getByTestId('clarifyStage').getByRole('textbox', { name: 'Title' })).toHaveValue('Mid-jump thought');

            // Back to Next Actions: both items were decided this review — nothing re-offers.
            await page.getByTestId('reviewStepperStep').nth(3).click();
            await expect(page.getByTestId('stageEmptyCard')).toBeVisible();
            await expect(page.getByTestId('reviewStageCounter')).toContainText('2 of 2');

            await gtd.flush(page);
            const items = await gtd.listItems(page);
            expect(items.find((i) => i._id === second._id)?.status).toBe('somedayMaybe');
        });
    });
});
