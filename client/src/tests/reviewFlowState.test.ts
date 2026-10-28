import { describe, expect, it } from 'vitest';
import {
    advanceStage,
    buildStageQueue,
    completeCurrentItem,
    completeEntry,
    currentQueueItemId,
    currentStage,
    decidedItemIds,
    dropCurrentItem,
    excludeFromLiveAppend,
    isChecklistComplete,
    isFlowComplete,
    jumpToStage,
    normalizeCalendarQueue,
    REVIEW_STAGES,
    reconcileQueue,
    refreshQueueOnEntry,
    removeDecision,
    requeueAtCursor,
    requeueReadiness,
    retireReviewedOccurrence,
    reviewStats,
    routineEntryId,
    routineIdOfEntry,
    type StageQueue,
    shouldResumeRevisit,
    skipCurrentItem,
    skipStage,
    stageEligibleEntryIds,
    stageEligibleItems,
    stageEndTitle,
    stageItemProgress,
    startReviewFlow,
    stepBack,
    toggleInboxTick,
    undoDecision,
    unreviewedStageArrivals,
    walkedEntryCount,
    withStageQueue,
    yieldCurrentSlot,
    yieldSlotOnDownMove,
} from '../components/weeklyReview/reviewFlowState';
import type { StoredItem, StoredRoutine } from '../types/MyDB';

const TODAY = '2026-08-23';
const CTX = { todayIso: TODAY, routines: [] };

function makeItem(overrides: Partial<StoredItem> & { _id: string; status: StoredItem['status'] }): StoredItem {
    return { userId: 'user-1', title: overrides._id, createdTs: '2026-01-01T00:00:00.000Z', updatedTs: '2026-01-01T00:00:00.000Z', ...overrides };
}

function makeCalendarRoutine(overrides: Partial<StoredRoutine> & { _id: string }): StoredRoutine {
    return {
        userId: 'user-1',
        title: overrides._id,
        routineType: 'calendar',
        rrule: 'FREQ=WEEKLY;BYDAY=TH',
        template: {},
        active: true,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

describe('stageEligibleItems', () => {
    it("clarify and finalSweep follow the inbox page's manual order — rank beats creation time", () => {
        const items = [
            makeItem({ _id: 'olderFirst', status: 'inbox', rank: 'a0', createdTs: '2026-01-01T00:00:00.000Z' }),
            makeItem({ _id: 'newerSecond', status: 'inbox', rank: 'a1', createdTs: '2026-02-01T00:00:00.000Z' }),
        ];
        expect(stageEligibleItems('clarify', items, CTX).map((item) => item._id)).toEqual(['olderFirst', 'newerSecond']);
        expect(stageEligibleItems('finalSweep', items, CTX).map((item) => item._id)).toEqual(['olderFirst', 'newerSecond']);
    });

    it("somedayMaybe follows the someday page's manual order too", () => {
        const items = [
            makeItem({ _id: 'second', status: 'somedayMaybe', rank: 'a1', createdTs: '2026-02-01T00:00:00.000Z' }),
            makeItem({ _id: 'first', status: 'somedayMaybe', rank: 'a0', createdTs: '2026-01-01T00:00:00.000Z' }),
        ];
        expect(stageEligibleItems('somedayMaybe', items, CTX).map((item) => item._id)).toEqual(['first', 'second']);
    });

    it('unranked inbox items (before the rank backfill) are newest-first, matching the inbox page', () => {
        const items = [
            makeItem({ _id: 'a', status: 'inbox', createdTs: '2026-01-01T00:00:00.000Z' }),
            makeItem({ _id: 'b', status: 'inbox', createdTs: '2026-02-01T00:00:00.000Z' }),
            makeItem({ _id: 'x', status: 'nextAction' }),
        ];
        expect(stageEligibleItems('clarify', items, CTX).map((item) => item._id)).toEqual(['b', 'a']);
        expect(stageEligibleItems('finalSweep', items, CTX).map((item) => item._id)).toEqual(['b', 'a']);
    });

    it('calendar takes every still-calendar item — past AND future — in the calendar-page order (all-day leads its day, undated last)', () => {
        const items = [
            makeItem({ _id: 'future', status: 'calendar', timeStart: '2026-09-01T10:00:00.000Z' }),
            // Same day as 'future' but all-day → the page renders it first within the day bucket.
            makeItem({ _id: 'futureAllDay', status: 'calendar', allDay: true, timeStart: '2026-09-01', timeEnd: '2026-09-02' }),
            makeItem({ _id: 'past', status: 'calendar', timeStart: '2026-08-01T10:00:00.000Z' }),
            makeItem({ _id: 'undated', status: 'calendar' }),
            makeItem({ _id: 'completed', status: 'done', timeStart: '2026-08-01T10:00:00.000Z' }),
        ];
        expect(stageEligibleItems('calendar', items, CTX).map((item) => item._id)).toEqual(['past', 'futureAllDay', 'future', 'undated']);
    });

    it('nextActions excludes tickler-hidden items; tickler takes exactly those (all three statuses)', () => {
        const items = [
            makeItem({ _id: 'visible', status: 'nextAction' }),
            makeItem({ _id: 'boundary', status: 'nextAction', ignoreBefore: TODAY }),
            makeItem({ _id: 'snoozed', status: 'nextAction', ignoreBefore: '2026-09-15' }),
            makeItem({ _id: 'snoozedWait', status: 'waitingFor', ignoreBefore: '2026-09-01' }),
            // somedayMaybe participates in the tickler too — mirror of the /tickler page status set.
            makeItem({ _id: 'snoozedPark', status: 'somedayMaybe', ignoreBefore: '2026-09-20' }),
            // Urgency does NOT override the tickler gate — a snoozed urgent item stays hidden.
            makeItem({ _id: 'snoozedFocus', status: 'nextAction', urgent: true, ignoreBefore: '2026-09-15' }),
        ];
        // ignoreBefore === today is visible (the tickler gate is strict >), matching /next-actions.
        // Both undated, unranked and created in the same ms → the total order falls back to _id.
        expect(stageEligibleItems('nextActions', items, CTX).map((item) => item._id)).toEqual(['boundary', 'visible']);
        expect(stageEligibleItems('tickler', items, CTX).map((item) => item._id)).toEqual(['snoozedWait', 'snoozed', 'snoozedFocus', 'snoozedPark']);
    });

    it('nextActions mirrors the Next Actions page order: expected day ascending, rank inside a day, undated last', () => {
        const items = [
            makeItem({ _id: 'undatedRanked', status: 'nextAction', rank: 'a1' }),
            makeItem({ _id: 'laterDay', status: 'nextAction', expectedBy: '2026-09-20', rank: 'a0' }),
            makeItem({ _id: 'soonerDaySecond', status: 'nextAction', expectedBy: '2026-08-25', rank: 'a1' }),
            // A datetime (local wall clock, no offset) collapses to the same day as the date-only sibling.
            makeItem({ _id: 'soonerDayFirst', status: 'nextAction', expectedBy: '2026-08-25T09:00:00', rank: 'a0' }),
            makeItem({ _id: 'undatedFresh', status: 'nextAction', createdTs: '2026-08-20T00:00:00.000Z' }),
        ];
        expect(stageEligibleItems('nextActions', items, CTX).map((item) => item._id)).toEqual([
            'soonerDayFirst',
            'soonerDaySecond',
            'laterDay',
            'undatedFresh',
            'undatedRanked',
        ]);
    });

    it('waitingFor walks chronologically (expectedBy ascending, undated first) across people — the page\'s "By date" view, NOT its person-grouped default', () => {
        const items = [
            makeItem({ _id: 'bobLater', status: 'waitingFor', waitingForPersonId: 'p-bob', expectedBy: '2026-09-10' }),
            makeItem({ _id: 'unassignedSoon', status: 'waitingFor', expectedBy: '2026-08-25' }),
            makeItem({ _id: 'aliceUndated', status: 'waitingFor', waitingForPersonId: 'p-alice' }),
            makeItem({ _id: 'bobSoon', status: 'waitingFor', waitingForPersonId: 'p-bob', expectedBy: '2026-08-24' }),
            makeItem({ _id: 'unassignedUndated', status: 'waitingFor' }),
            makeItem({ _id: 'hidden', status: 'waitingFor', waitingForPersonId: 'p-alice', ignoreBefore: '2026-12-01' }),
        ];
        // Bob's two items are split apart by an unassigned one: date order beats person grouping.
        expect(stageEligibleItems('waitingFor', items, CTX).map((item) => item._id)).toEqual([
            'aliceUndated',
            'unassignedUndated',
            'bobSoon',
            'unassignedSoon',
            'bobLater',
        ]);
    });

    it('somedayMaybe excludes tickler-hidden items (they belong to the tickler stage), newest-first like the someday page', () => {
        const items = [
            makeItem({ _id: 'parked', status: 'somedayMaybe', ignoreBefore: '2027-01-01', createdTs: '2026-01-01T00:00:00.000Z' }),
            makeItem({ _id: 'plain', status: 'somedayMaybe', createdTs: '2026-02-01T00:00:00.000Z' }),
            makeItem({ _id: 'due', status: 'somedayMaybe', ignoreBefore: TODAY, createdTs: '2026-01-15T00:00:00.000Z' }),
        ];
        // 'parked' is snoozed → reviewed by the tickler stage instead; 'due' surfaced today.
        expect(stageEligibleItems('somedayMaybe', items, CTX).map((item) => item._id)).toEqual(['plain', 'due']);
        expect(stageEligibleItems('tickler', items, CTX).map((item) => item._id)).toEqual(['parked']);
    });
});

describe('stage queue', () => {
    it('complete removes the current item for good and records the decision with its undo payload', () => {
        const queue = buildStageQueue(['a', 'b']);
        // No undo (routine-generated / clarify-to-routine), requeue-only undo (no-write decision),
        // and full snapshot undo — the three shapes StageDecision.undo distinguishes.
        expect(completeCurrentItem(queue)).toEqual({ pending: ['b'], cursor: 0, decisions: [{ itemId: 'a' }] });
        expect(completeCurrentItem(queue, {})).toEqual({ pending: ['b'], cursor: 0, decisions: [{ itemId: 'a', undo: {} }] });
        const snapshot = makeItem({ _id: 'a', status: 'nextAction' });
        expect(completeCurrentItem(queue, { snapshot })).toEqual({ pending: ['b'], cursor: 0, decisions: [{ itemId: 'a', undo: { snapshot } }] });
    });

    it('complete mid-walk removes at the cursor; the cursor then points at the next undecided item', () => {
        const midWalk = skipCurrentItem(buildStageQueue(['a', 'b', 'c'])); // cursor on 'b'
        const decided = completeCurrentItem(midWalk);
        expect(decided.pending).toEqual(['a', 'c']);
        expect(decidedItemIds(decided)).toEqual(['b']);
        expect(currentQueueItemId(decided)).toBe('c');
    });

    // The decision belongs to the entry the user acted on. A reconcile can land between the write
    // and the decision (the write made that entry ineligible) and move "current" to the next one —
    // completing "current" then would silently decide an entry the user never saw.
    it('completeEntry decides the named entry, never whichever one is current by then', () => {
        const queue = buildStageQueue(['gym', 'pool', 'exception']);
        const reconciledAway = reconcileQueue(queue, ['pool', 'exception']);
        expect(currentQueueItemId(reconciledAway)).toBe('pool');

        const decided = completeEntry(reconciledAway, 'gym');

        expect(decidedItemIds(decided)).toEqual(['gym']);
        expect(decided.pending).toEqual(['pool', 'exception']);
        expect(currentQueueItemId(decided)).toBe('pool');
    });

    it('completeEntry removes a still-pending entry and keeps the cursor on the same next entry', () => {
        const midWalk = skipCurrentItem(buildStageQueue(['a', 'b', 'c'])); // cursor on 'b'
        expect(completeEntry(midWalk, 'b', {})).toEqual({ pending: ['a', 'c'], cursor: 1, decisions: [{ itemId: 'b', undo: {} }] });
        // Deciding an entry BEFORE the cursor shifts the cursor down so it still points at 'b'.
        const decidedEarlier = completeEntry(midWalk, 'a');
        expect(decidedEarlier.pending).toEqual(['b', 'c']);
        expect(currentQueueItemId(decidedEarlier)).toBe('b');
    });

    it('completeEntry is a no-op for an entry already decided', () => {
        const decided = completeEntry(buildStageQueue(['a', 'b']), 'a');
        expect(completeEntry(decided, 'a')).toBe(decided);
    });

    it('skip advances the cursor without reordering, and the walk ENDS past the last item (no cycling)', () => {
        const queue = buildStageQueue(['a', 'b', 'c']);
        const afterOneSkip = skipCurrentItem(queue);
        expect(afterOneSkip.pending).toEqual(['a', 'b', 'c']);
        expect(currentQueueItemId(afterOneSkip)).toBe('b');
        const atEnd = skipCurrentItem(skipCurrentItem(afterOneSkip));
        expect(atEnd.cursor).toBe(3);
        expect(currentQueueItemId(atEnd)).toBeNull(); // the stage-end card, not 'a' again
        expect(skipCurrentItem(atEnd)).toBe(atEnd); // same reference — nowhere further to go
    });

    it('walkedEntryCount counts decided AND skipped-past entries — the "n of m" position, not a decided tally', () => {
        const queue = buildStageQueue(['a', 'b', 'c']);
        expect(walkedEntryCount(queue)).toBe(0);
        // A ▶ skip moves the position exactly like a decision does; ◀ steps it back.
        expect(walkedEntryCount(skipCurrentItem(queue))).toBe(1);
        expect(walkedEntryCount(completeCurrentItem(skipCurrentItem(queue)))).toBe(2);
        expect(walkedEntryCount(stepBack(skipCurrentItem(queue)))).toBe(0);
        // An all-skips walk reaches "3 of 3" at the end card — the original bug pinned this at 0.
        expect(walkedEntryCount(skipCurrentItem(skipCurrentItem(skipCurrentItem(queue))))).toBe(3);
    });

    describe('stageItemProgress', () => {
        it('numbers the current item from 1 — a single-item stage reads "1 of 1" on its only card', () => {
            expect(stageItemProgress(buildStageQueue(['a']))).toEqual({ position: 1, total: 1, percent: 0 });
        });

        it('gives the stage-end card no ordinal — it is not an item, so "1 of 1" never repeats there', () => {
            const atEnd = completeCurrentItem(buildStageQueue(['a']));
            expect(stageItemProgress(atEnd)).toEqual({ position: null, total: 1, percent: 100 });
        });

        it('advances the position on a skip and a decision alike, and the bar tracks entries walked past', () => {
            const queue = buildStageQueue(['a', 'b', 'c']);
            expect(stageItemProgress(queue)).toEqual({ position: 1, total: 3, percent: 0 });
            expect(stageItemProgress(skipCurrentItem(queue))).toEqual({ position: 2, total: 3, percent: 33 });
            expect(stageItemProgress(completeCurrentItem(skipCurrentItem(queue)))).toEqual({ position: 3, total: 3, percent: 67 });
            expect(stageItemProgress(skipCurrentItem(skipCurrentItem(skipCurrentItem(queue))))).toEqual({ position: null, total: 3, percent: 100 });
        });

        it('is null for a missing or empty queue — nothing to count', () => {
            expect(stageItemProgress(undefined)).toBeNull();
            expect(stageItemProgress(buildStageQueue([]))).toBeNull();
        });
    });

    it('stepBack reverses skips one at a time and no-ops at the start', () => {
        const atEnd = skipCurrentItem(skipCurrentItem(buildStageQueue(['a', 'b'])));
        const backOnce = stepBack(atEnd);
        expect(currentQueueItemId(backOnce)).toBe('b');
        const backTwice = stepBack(backOnce);
        expect(currentQueueItemId(backTwice)).toBe('a');
        expect(stepBack(backTwice)).toBe(backTwice); // same reference at cursor 0
    });

    it('undoDecision removes the history entry and returns the id to the CURSOR position', () => {
        // Decide 'a' then 'b'; undo 'a' — it must render as the current item again.
        const decided = completeCurrentItem(completeCurrentItem(buildStageQueue(['a', 'b', 'c'])), { snapshot: makeItem({ _id: 'b', status: 'done' }) });
        const undone = undoDecision(decided, 'a');
        expect(undone.pending).toEqual(['a', 'c']);
        expect(currentQueueItemId(undone)).toBe('a');
        expect(decidedItemIds(undone)).toEqual(['b']);
        // The surviving decision keeps its undo payload.
        expect(undone.decisions[0]?.undo?.snapshot?._id).toBe('b');
    });

    it('undoDecision mid-walk inserts at the cursor, ahead of the remaining unvisited items', () => {
        // Skip 'a', decide 'b' → walking with 'a' behind and 'c' current; undoing 'b' must show it now.
        const decided = completeCurrentItem(skipCurrentItem(buildStageQueue(['a', 'b', 'c'])));
        const undone = undoDecision(decided, 'b');
        expect(undone.pending).toEqual(['a', 'b', 'c']);
        expect(currentQueueItemId(undone)).toBe('b');
    });

    it('undoDecision on an id without a decision is a no-op (same reference)', () => {
        const decided = completeCurrentItem(buildStageQueue(['a', 'b']));
        expect(undoDecision(decided, 'nope')).toBe(decided);
    });

    it('an undone id is decidable again — the second decision re-records it', () => {
        const decided = completeCurrentItem(buildStageQueue(['a']));
        const redecided = completeCurrentItem(undoDecision(decided, 'a'));
        expect(redecided).toEqual({ pending: [], cursor: 0, decisions: [{ itemId: 'a' }] });
    });

    it('undo at revisit offset n + re-decide keeps offset n on the same chronological slot (revisit-resume invariant)', () => {
        // Decide a, b, c, d — the revisit walk indexes decisions from the newest: offset n shows
        // decisions[length - n]. The stage hook restores offset n after an undo-at-n + re-decide;
        // this pins the queue math that makes that restore land on the same "p of N" slot.
        const allDecided = ['a', 'b', 'c', 'd'].reduce((queue, _id) => completeCurrentItem(queue, {}), buildStageQueue(['a', 'b', 'c', 'd']));
        const offset = 3; // viewing 'b' — position "2 of 4"
        const viewed = allDecided.decisions[allDecided.decisions.length - offset];
        expect(viewed?.itemId).toBe('b');
        const redecided = completeCurrentItem(undoDecision(allDecided, 'b'), {});
        // The re-decision re-enters the history at its END...
        expect(decidedItemIds(redecided)).toEqual(['a', 'c', 'd', 'b']);
        // ...so the SAME offset shows the old position's chronological successor ('c', still
        // labeled "2 of 4"), and offset+1 continues into the older, not-yet-revisited 'a'.
        expect(redecided.decisions[redecided.decisions.length - offset]?.itemId).toBe('c');
        expect(redecided.decisions[redecided.decisions.length - (offset + 1)]?.itemId).toBe('a');
    });

    it('shouldResumeRevisit applies only when the live cursor sits on the resumed item itself', () => {
        const queue = buildStageQueue(['a', 'b']);
        expect(shouldResumeRevisit({ itemId: 'a', offset: 1 }, queue)).toBe(true);
        // Cursor moved on (skip, reconcile drop, another decision) — the stored position no longer applies.
        expect(shouldResumeRevisit({ itemId: 'b', offset: 1 }, queue)).toBe(false);
        expect(shouldResumeRevisit(null, queue)).toBe(false);
        // Past the end (currentQueueItemId → null) never matches.
        expect(shouldResumeRevisit({ itemId: 'a', offset: 1 }, skipCurrentItem(skipCurrentItem(queue)))).toBe(false);
    });

    it('the two-phase undo pieces: removeDecision leaves pending alone; requeueAtCursor never duplicates', () => {
        const decided = completeCurrentItem(buildStageQueue(['a', 'b']));
        const withoutDecision = removeDecision(decided, 'a');
        expect(withoutDecision).toEqual({ pending: ['b'], cursor: 0, decisions: [] });
        expect(removeDecision(decided, 'nope')).toBe(decided);
        expect(requeueAtCursor(withoutDecision, 'a').pending).toEqual(['a', 'b']);
        // Already at the cursor, or (re-)decided in the meantime — a late deferred requeue must no-op.
        expect(requeueAtCursor(withoutDecision, 'b')).toBe(withoutDecision);
        expect(requeueAtCursor(decided, 'a')).toBe(decided);
    });

    it('requeueAtCursor moves a live-appended id to the cursor instead of duplicating it', () => {
        // The reconcile raced the undo's deferred phase 2 and already appended 'a' at the end of
        // the walk — the requeue must surface it as the current item, once.
        const midWalk = { pending: ['b', 'c', 'a'], cursor: 1, decisions: [] };
        const requeued = requeueAtCursor(midWalk, 'a');
        expect(requeued.pending).toEqual(['b', 'a', 'c']);
        expect(currentQueueItemId(requeued)).toBe('a');
    });

    it('requeueAtCursor clamps a past-the-end cursor so the requeued item is current, not beyond it', () => {
        // The walk ended (cursor == length), then an undo requeues — the item must render, not
        // leave the cursor pointing past a longer list.
        const ended = skipCurrentItem(completeCurrentItem(buildStageQueue(['a', 'b'])));
        const requeued = requeueAtCursor(removeDecision(ended, 'a'), 'a');
        expect(currentQueueItemId(requeued)).toBe('a');
    });

    it('requeueReadiness gates the deferred requeue: wait for the restored write, abort on a vanished row', () => {
        const restoredTs = '2026-08-24T10:00:00.000Z';
        const stale = makeItem({ _id: 'x', status: 'done', updatedTs: '2026-08-24T09:59:59.999Z' });
        expect(requeueReadiness(stale, restoredTs)).toBe('wait');
        expect(requeueReadiness({ ...stale, updatedTs: restoredTs }, restoredTs)).toBe('requeue');
        expect(requeueReadiness({ ...stale, updatedTs: '2026-08-24T10:00:01.000Z' }, restoredTs)).toBe('requeue');
        expect(requeueReadiness(undefined, restoredTs)).toBe('abort');
    });

    it('skip on a single-item queue walks straight to the end; skip on empty is a no-op', () => {
        const past = skipCurrentItem(buildStageQueue(['only']));
        expect(past.pending).toEqual(['only']); // still undecided — just walked past
        expect(currentQueueItemId(past)).toBeNull();
        expect(skipCurrentItem(buildStageQueue([]))).toEqual(buildStageQueue([]));
        expect(currentQueueItemId(buildStageQueue([]))).toBeNull();
    });

    it('drop removes the current item WITHOUT recording a decision — the blocked-item escape', () => {
        // Unlike a skip (which leaves the item in the walk), drop is what the mid-reassign bar uses.
        const singleton = buildStageQueue(['blocked']);
        expect(dropCurrentItem(singleton)).toEqual({ pending: [], cursor: 0, decisions: [], droppedIds: ['blocked'] });
        expect(dropCurrentItem(buildStageQueue(['blocked', 'next']))).toEqual({ pending: ['next'], cursor: 0, decisions: [], droppedIds: ['blocked'] });
        expect(dropCurrentItem(buildStageQueue([]))).toEqual(buildStageQueue([]));
        // Past the end there is nothing to drop.
        const ended = skipCurrentItem(buildStageQueue(['only']));
        expect(dropCurrentItem(ended)).toBe(ended);
    });

    it('a dropped id is re-offered on stage re-entry, in the page order (undecided, no longer queued → newcomer)', () => {
        const dropped = dropCurrentItem(buildStageQueue(['blocked', 'next']));
        expect(refreshQueueOnEntry(dropped, ['blocked', 'next']).pending).toEqual(['blocked', 'next']);
    });

    it('stage-end title distinguishes skipped, all-reviewed, and never-had-anything', () => {
        const labels = { stageName: 'Next Actions', allReviewed: 'Next Actions — all reviewed!', empty: 'Next Actions — nothing to review' };
        expect(stageEndTitle(labels, skipCurrentItem(buildStageQueue(['a'])))).toBe('Next Actions — 1 skipped');
        expect(stageEndTitle(labels, completeCurrentItem(buildStageQueue(['a'])))).toBe('Next Actions — all reviewed!');
        expect(stageEndTitle(labels, buildStageQueue([]))).toBe('Next Actions — nothing to review');
    });

    it('a blocked drop at the end of the walk leaves ◀ pointing at the last skipped item', () => {
        const dropped = dropCurrentItem(skipCurrentItem(buildStageQueue(['a', 'b'])));
        expect(dropped).toEqual({ pending: ['a'], cursor: 1, decisions: [], droppedIds: ['b'] });
        expect(currentQueueItemId(stepBack(dropped))).toBe('a');
    });

    it('reconcile drops ids no longer eligible and preserves reference when unchanged', () => {
        const queue = buildStageQueue(['a', 'b', 'c']);
        const reconciled = reconcileQueue(queue, ['a', 'c']);
        expect(reconciled.pending).toEqual(['a', 'c']);
        expect(reconcileQueue(queue, ['a', 'b', 'c'])).toBe(queue);
    });

    it('reconcile keeps the cursor on the same item when earlier ids vanish, and clamps when the tail does', () => {
        const midWalk = skipCurrentItem(skipCurrentItem(buildStageQueue(['a', 'b', 'c']))); // on 'c'
        const droppedEarlier = reconcileQueue(midWalk, ['b', 'c']);
        expect(currentQueueItemId(droppedEarlier)).toBe('c');
        const droppedCurrent = reconcileQueue(midWalk, ['a', 'b']);
        expect(currentQueueItemId(droppedCurrent)).toBeNull(); // cursor clamped past the shortened end
        expect(droppedCurrent.cursor).toBe(2);
    });

    it('reconcile live-appends new arrivals at the end of the walk without moving the cursor', () => {
        const midWalk = skipCurrentItem(buildStageQueue(['a', 'b'])); // on 'b'
        const grown = reconcileQueue(midWalk, ['a', 'b', 'c']);
        expect(grown.pending).toEqual(['a', 'b', 'c']);
        expect(currentQueueItemId(grown)).toBe('b'); // still on the same item; 'c' waits its turn
    });

    it('reconcile never re-offers an id dropped from this visit, but a stage re-entry does', () => {
        const dropped = dropCurrentItem(buildStageQueue(['a', 'b'])); // 'a' dropped (blocked escape hatch)
        expect(dropped.pending).toEqual(['b']);
        // Still eligible — mid-stage the reconcile must NOT put it back…
        expect(reconcileQueue(dropped, ['a', 'b'])).toBe(dropped);
        // …but re-entering the stage consciously re-offers it and clears the drop list.
        const reentered = refreshQueueOnEntry(dropped, ['a', 'b']);
        expect(reentered.pending).toEqual(['a', 'b']);
        expect(reconcileQueue(reentered, ['a', 'b'])).toBe(reentered);
    });

    it('undo gap: an excluded id survives the reconcile at its cursor destination, not the end', () => {
        // Phase 1 of a snapshot undo: decision removed, id parked on the exclusion list.
        const decided = completeCurrentItem(skipCurrentItem(buildStageQueue(['a', 'b']))); // 'b' decided, on end card
        const midUndo = excludeFromLiveAppend(removeDecision(decided, 'b'), 'b');
        // The restored item is eligible again — the racing reconcile must not append it.
        expect(reconcileQueue(midUndo, ['a', 'b'])).toBe(midUndo);
        // Phase 2 places it at the cursor and lifts the exclusion.
        const requeued = requeueAtCursor(midUndo, 'b');
        expect(currentQueueItemId(requeued)).toBe('b');
        expect(requeued.droppedIds).toEqual([]);
    });

    it('a drop survives subsequent decisions — the reconcile must not re-offer it mid-stage', () => {
        const afterDecision = completeCurrentItem(dropCurrentItem(buildStageQueue(['blocked', 'b'])));
        expect(afterDecision.droppedIds).toEqual(['blocked']);
        expect(reconcileQueue(afterDecision, ['blocked', 'b'])).toBe(afterDecision);
    });

    it('an undo-gap exclusion survives a concurrent decision on another item', () => {
        const decided = completeCurrentItem(buildStageQueue(['a', 'b', 'c'])); // 'a' decided
        const midUndo = excludeFromLiveAppend(removeDecision(decided, 'a'), 'a');
        const afterNextDecision = completeCurrentItem(midUndo); // 'b' decided during the gap
        expect(afterNextDecision.droppedIds).toEqual(['a']);
        expect(reconcileQueue(afterNextDecision, ['a', 'c'])).toBe(afterNextDecision);
    });

    it('a routine card retires the occurrence it reviewed: an exception born from that edit never re-offers it mid-stage', () => {
        const routineEntry = routineEntryId('r1');
        // Retired at decision time — before the save makes the edited occurrence an exception.
        const retired = retireReviewedOccurrence(buildStageQueue([routineEntry, 'next']), 'occ');
        expect(reconcileQueue(retired, [routineEntry, 'next', 'occ'])).toBe(retired);
    });

    it('a routine card retires an exception the reconcile already appended (a text autosave made it one mid-card)', () => {
        const routineEntry = routineEntryId('r1');
        const appended = reconcileQueue(buildStageQueue([routineEntry, 'next']), [routineEntry, 'next', 'occ']);
        expect(appended.pending).toEqual([routineEntry, 'next', 'occ']);
        const retired = retireReviewedOccurrence(appended, 'occ');
        expect(retired.pending).toEqual([routineEntry, 'next']);
        expect(currentQueueItemId(retired)).toBe(routineEntry);
        expect(decidedItemIds(retired)).toEqual([]);
    });

    it('retiring the id AT the cursor lands the walk on its successor', () => {
        const queue = { pending: ['a', 'occ', 'b'], cursor: 1, decisions: [] };
        expect(currentQueueItemId(retireReviewedOccurrence(queue, 'occ'))).toBe('b');
    });

    it('retiring an id that is not queued only excludes it from the live append', () => {
        const queue = buildStageQueue(['a']);
        const retired = retireReviewedOccurrence(queue, 'occ');
        expect(retired.pending).toEqual(['a']);
        expect(retired.droppedIds).toEqual(['occ']);
    });

    it('retiring keeps the cursor on the same entry when the retired id sat before it', () => {
        const queue = { pending: ['occ', 'current'], cursor: 1, decisions: [] };
        expect(currentQueueItemId(retireReviewedOccurrence(queue, 'occ'))).toBe('current');
    });

    it('entry refresh returns the same reference for an unchanged queue that carries an empty droppedIds array', () => {
        // This identity is what lets the wizard's queue effect settle — pin it for the
        // droppedIds-present shape too.
        const queue = { pending: ['a'], cursor: 0, decisions: [], droppedIds: [] };
        expect(refreshQueueOnEntry(queue, ['a'])).toBe(queue);
        expect(reconcileQueue(queue, ['a'])).toBe(queue);
    });

    it('reconcile hands a newcomer to a user parked on the stage-end card, but never re-offers decided ids', () => {
        // Everything decided — the user sits on the end card (cursor === pending.length === 0).
        const atEnd = completeCurrentItem(buildStageQueue(['a']));
        const grown = reconcileQueue(atEnd, ['a', 'b']);
        expect(grown.pending).toEqual(['b']); // 'a' was decided — not re-offered
        expect(currentQueueItemId(grown)).toBe('b'); // the end card flips to the arrival
    });

    it('sweep counts eligible items a visited stage never queued nor decided', () => {
        const nextAction = makeItem({ _id: 'na1', status: 'nextAction' });
        const waiting = makeItem({ _id: 'wf1', status: 'waitingFor' });
        const base = startReviewFlow('2026-08-23T00:00:00.000Z');
        // nextActions fully reviewed; waitingFor visited while empty — 'wf1' arrived after.
        const flow = withStageQueue(withStageQueue(base, 'nextActions', completeCurrentItem(buildStageQueue(['na1']))), 'waitingFor', buildStageQueue([]));
        expect(unreviewedStageArrivals(flow, [nextAction, waiting], CTX)).toEqual([{ stageId: 'waitingFor', title: 'Waiting For', count: 1 }]);
    });

    it('sweep ignores skipped-but-offered pending ids and stages never visited', () => {
        const nextAction = makeItem({ _id: 'na1', status: 'nextAction' });
        const waiting = makeItem({ _id: 'wf1', status: 'waitingFor' });
        // 'wf1' was offered (still pending after a skip); nextActions was bypassed wholesale (no queue).
        const flow = withStageQueue(startReviewFlow('2026-08-23T00:00:00.000Z'), 'waitingFor', skipCurrentItem(buildStageQueue(['wf1'])));
        expect(unreviewedStageArrivals(flow, [nextAction, waiting], CTX)).toEqual([]);
    });

    it('sweep never second-guesses a focus-stage decision: a review-snoozed item is not a tickler arrival', () => {
        // 'x' was decided in the nextActions stage — the decision snoozed it into the tickler.
        const snoozed = makeItem({ _id: 'x', status: 'nextAction', ignoreBefore: '2026-12-01' });
        const base = startReviewFlow('2026-08-23T00:00:00.000Z');
        const flow = withStageQueue(withStageQueue(base, 'nextActions', completeCurrentItem(buildStageQueue(['x']))), 'tickler', buildStageQueue([]));
        expect(unreviewedStageArrivals(flow, [snoozed], CTX)).toEqual([]);
    });

    it('sweep counts a clarify-stage decision as an arrival for the list it landed in', () => {
        // Final sweep clarified 'x' into waitingFor — the entry was never reviewed in its list.
        const clarified = makeItem({ _id: 'x', status: 'waitingFor' });
        const base = startReviewFlow('2026-08-23T00:00:00.000Z');
        const flow = withStageQueue(withStageQueue(base, 'finalSweep', completeCurrentItem(buildStageQueue(['x']))), 'waitingFor', buildStageQueue([]));
        expect(unreviewedStageArrivals(flow, [clarified], CTX)).toEqual([{ stageId: 'waitingFor', title: 'Waiting For', count: 1 }]);
    });

    it('sweep reports a late inbox capture once, under Final sweep — never doubled via Clarify', () => {
        const lateCapture = makeItem({ _id: 'late', status: 'inbox' });
        const base = startReviewFlow('2026-08-23T00:00:00.000Z');
        const flow = withStageQueue(withStageQueue(base, 'clarify', buildStageQueue([])), 'finalSweep', buildStageQueue([]));
        expect(unreviewedStageArrivals(flow, [lateCapture], CTX)).toEqual([{ stageId: 'finalSweep', title: 'Final sweep', count: 1 }]);
    });

    it('sweep returns arrivals in stage order so the earliest stale stage leads', () => {
        const calItem = makeItem({ _id: 'cal', status: 'calendar', timeStart: '2026-09-01T10:00:00.000Z' });
        const waiting = makeItem({ _id: 'wf', status: 'waitingFor' });
        const base = startReviewFlow('2026-08-23T00:00:00.000Z');
        const flow = withStageQueue(withStageQueue(base, 'waitingFor', buildStageQueue([])), 'calendar', buildStageQueue([]));
        expect(unreviewedStageArrivals(flow, [waiting, calItem], CTX).map((arrival) => arrival.stageId)).toEqual(['calendar', 'waitingFor']);
    });

    it('entry refresh keeps undecided leftovers, appends new arrivals, and never re-offers decided ids', () => {
        // 'a' decided, 'b' skipped (still pending), 'c' newly eligible since the stage was entered.
        const afterOneDecision = completeCurrentItem(buildStageQueue(['a', 'b']));
        const refreshed = refreshQueueOnEntry(afterOneDecision, ['a', 'b', 'c']);
        expect(refreshed.pending).toEqual(['b', 'c']);
        expect(decidedItemIds(refreshed)).toEqual(['a']);
    });

    it('entry refresh drops pending ids that stopped qualifying and builds fresh when no queue exists', () => {
        const queue = buildStageQueue(['a', 'b']);
        expect(refreshQueueOnEntry(queue, ['b']).pending).toEqual(['b']);
        expect(refreshQueueOnEntry(undefined, ['x', 'y'])).toEqual({ pending: ['x', 'y'], cursor: 0, decisions: [] });
    });

    it('entry refresh preserves reference when nothing changed', () => {
        const queue = completeCurrentItem(buildStageQueue(['a', 'b']));
        expect(refreshQueueOnEntry(queue, ['a', 'b'])).toBe(queue);
    });

    it('entry refresh lays the leftovers out in the current page order — a rank change made elsewhere is honoured on re-entry', () => {
        const ended = skipCurrentItem(skipCurrentItem(buildStageQueue(['a', 'b'])));
        const refreshed = refreshQueueOnEntry(ended, ['b', 'a']);
        expect(refreshed.pending).toEqual(['b', 'a']);
        expect(currentQueueItemId(refreshed)).toBe('b');
    });

    it('entry refresh restarts the walk at the first undecided item (cursor 0), keeping order', () => {
        // The walk ended with 'a' and 'b' skipped past — re-entering the stage re-offers them
        // from the top plus the newcomer, instead of resuming past the end.
        const ended = skipCurrentItem(skipCurrentItem(buildStageQueue(['a', 'b'])));
        const refreshed = refreshQueueOnEntry(ended, ['a', 'b', 'd']);
        expect(refreshed.pending).toEqual(['a', 'b', 'd']);
        expect(currentQueueItemId(refreshed)).toBe('a');
    });
});

describe('stage queue follows rank changes mid-stage', () => {
    it('the current item, yielded by its card and moved DOWN, leaves the cursor slot: the walk moves on and re-offers it at its new place', () => {
        const queue = buildStageQueue(['a', 'b', 'c']); // on 'a'
        const moved = reconcileQueue(yieldCurrentSlot(queue), ['b', 'c', 'a']); // 'a' sent to the bottom
        expect(moved).toEqual({ pending: ['b', 'c', 'a'], cursor: 0, decisions: [] });
        expect(walkedEntryCount(moved)).toBe(0);
    });

    it('the current item, yielded and moved UP, stays current — only the list rank changed, and the yield is consumed', () => {
        const midWalk = skipCurrentItem(buildStageQueue(['a', 'b', 'c'])); // on 'b', 'a' skipped
        const moved = reconcileQueue(yieldCurrentSlot(midWalk), ['b', 'a', 'c']); // 'b' moved above the skipped 'a'
        expect(moved).toEqual(midWalk);
    });

    it('without a yield the card on screen is pinned: an entry that ranks above it never takes its slot', () => {
        const queue = buildStageQueue(['a', 'b', 'c']); // on 'a'
        expect(reconcileQueue(queue, ['b', 'c', 'a'])).toEqual({ pending: ['a', 'b', 'c'], cursor: 0, decisions: [] });
        expect(reconcileQueue(queue, ['b', 'c', 'a'])).toBe(queue);
    });

    it('a rank change behind the cursor never reorders the walked prefix', () => {
        const midWalk = skipCurrentItem(skipCurrentItem(buildStageQueue(['a', 'b', 'c']))); // on 'c'
        expect(reconcileQueue(midWalk, ['b', 'a', 'c'])).toBe(midWalk);
    });

    it('the unwalked tail re-sorts to the list order while the current item keeps its slot', () => {
        const queue = buildStageQueue(['a', 'b', 'c', 'd']); // on 'a'
        const reordered = reconcileQueue(queue, ['a', 'd', 'c', 'b']);
        expect(reordered.pending).toEqual(['a', 'd', 'c', 'b']);
        expect(currentQueueItemId(reordered)).toBe('a');
    });

    it('a newcomer joins the tail at its list position, never ahead of the item on screen — and stays behind it on later reconciles', () => {
        const queue = buildStageQueue(['a', 'b', 'c']); // on 'a'
        // 'n' ranks at the very top of the list (a fresh inbox capture) — the card on screen must not switch.
        const grown = reconcileQueue(queue, ['n', 'a', 'b', 'c']);
        expect(grown.pending).toEqual(['a', 'n', 'b', 'c']);
        expect(currentQueueItemId(grown)).toBe('a');
        // Once queued, 'n' is a leftover ranked above the card — still no hijack (the live-capture e2e scenario).
        expect(reconcileQueue(grown, ['n', 'a', 'b', 'c'])).toBe(grown);
        const midList = reconcileQueue(queue, ['a', 'b', 'n', 'c']);
        expect(midList.pending).toEqual(['a', 'b', 'n', 'c']);
    });

    it('a newcomer ranked above the current item takes its turn once the current item is decided', () => {
        const grown = reconcileQueue(buildStageQueue(['a', 'b']), ['n', 'a', 'b']);
        const decided = completeCurrentItem(grown);
        expect(currentQueueItemId(decided)).toBe('n');
    });

    it('the yielded current item moved down past a newcomer: the whole tail follows the list order', () => {
        const queue = buildStageQueue(['a', 'b']); // on 'a'
        const moved = reconcileQueue(yieldCurrentSlot(queue), ['n', 'b', 'a']);
        expect(moved.pending).toEqual(['n', 'b', 'a']);
        expect(currentQueueItemId(moved)).toBe('n');
    });

    it('a yield is consumed by one reconcile: the next one pins the new current item again', () => {
        const once = reconcileQueue(yieldCurrentSlot(buildStageQueue(['a', 'b', 'c'])), ['b', 'c', 'a']);
        expect(once.yieldedEntryId).toBeUndefined();
        expect(reconcileQueue(once, ['c', 'b', 'a'])).toEqual({ ...once, pending: ['b', 'c', 'a'] });
        expect(reconcileQueue(once, ['b', 'c', 'a'])).toBe(once);
    });

    it('a yield that changes nothing is still consumed, and one on the stage-end card is a no-op', () => {
        const queue = buildStageQueue(['a', 'b']);
        expect(reconcileQueue(yieldCurrentSlot(queue), ['a', 'b'])).toEqual(queue);
        const atEnd = skipCurrentItem(skipCurrentItem(queue));
        expect(yieldCurrentSlot(atEnd)).toBe(atEnd);
    });

    it('on the stage-end card two arrivals land in list order, not arrival order, and the first takes the screen', () => {
        const atEnd = completeCurrentItem(buildStageQueue(['a']));
        const grown = reconcileQueue(atEnd, ['y', 'x', 'a']);
        expect(grown.pending).toEqual(['y', 'x']);
        expect(currentQueueItemId(grown)).toBe('y');
    });

    it('a current item that turned ineligible hands over to the first entry in list order — a newcomer ranked above the leftovers included', () => {
        const queue = buildStageQueue(['a', 'b', 'c']); // on 'a', then 'a' is completed on another device
        const handedOver = reconcileQueue(queue, ['n', 'b', 'c']);
        expect(handedOver.pending).toEqual(['n', 'b', 'c']);
        expect(currentQueueItemId(handedOver)).toBe('n');
    });

    it('an UP move never yields: with earlier arrivals ranked above it, the card stays on screen and the tail re-sorts behind it', () => {
        // Two live captures queued behind current 'a' while ranking above it; the user presses Up on 'a'.
        const grown = reconcileQueue(reconcileQueue(buildStageQueue(['a', 'b']), ['n1', 'a', 'b']), ['n1', 'n2', 'a', 'b']);
        expect(grown.pending).toEqual(['a', 'n1', 'n2', 'b']);
        const raised = reconcileQueue(grown, ['n1', 'a', 'n2', 'b']);
        expect(currentQueueItemId(raised)).toBe('a');
        expect(raised.pending).toEqual(['a', 'n1', 'n2', 'b']);
    });

    it('yieldSlotOnDownMove marks the queue on a down move only', () => {
        const queue = buildStageQueue(['a', 'b']);
        const applied: StageQueue[] = [];
        const onMoved = yieldSlotOnDownMove((update) => applied.push(update(queue)));
        onMoved('up');
        expect(applied).toEqual([]);
        onMoved('down');
        expect(applied).toEqual([{ ...queue, yieldedEntryId: 'a' }]);
    });

    it('stage entry drops a yield left over from the previous visit', () => {
        const yielded = yieldCurrentSlot(buildStageQueue(['a', 'b']));
        const reentered = refreshQueueOnEntry(yielded, ['a', 'b']);
        expect(reentered.yieldedEntryId).toBeUndefined();
        expect(reentered).toEqual({ pending: ['a', 'b'], cursor: 0, decisions: [], droppedIds: [] });
    });

    it('a dropped id stays out of the walk even when the list order around it changes', () => {
        const dropped = dropCurrentItem(buildStageQueue(['a', 'b', 'c'])); // 'a' dropped, on 'b'
        const reordered = reconcileQueue(yieldCurrentSlot(dropped), ['c', 'a', 'b']);
        expect(reordered.pending).toEqual(['c', 'b']);
        expect(currentQueueItemId(reordered)).toBe('c');
    });
});

describe('review flow', () => {
    it('walks the stages in the designed order — Waiting For before Next Actions', () => {
        expect(REVIEW_STAGES.map((stage) => stage.id)).toEqual([
            'clearInboxes',
            'clarify',
            'calendar',
            'waitingFor',
            'nextActions',
            'tickler',
            'somedayMaybe',
            'finalSweep',
        ]);
    });

    it('advances stage by stage to completion', () => {
        let flow = startReviewFlow('2026-08-23T09:00:00.000Z');
        expect(currentStage(flow)?.id).toBe('clearInboxes');
        for (let i = 0; i < REVIEW_STAGES.length; i++) {
            expect(isFlowComplete(flow)).toBe(false);
            flow = advanceStage(flow);
        }
        expect(isFlowComplete(flow)).toBe(true);
        expect(currentStage(flow)).toBeNull();
    });

    it('skipStage records the skipped stage id and advances', () => {
        const flow = skipStage(startReviewFlow('2026-08-23T09:00:00.000Z'));
        expect(flow.stageIndex).toBe(1);
        expect(flow.skippedStageIds).toEqual(['clearInboxes']);
    });

    it('skipping the same stage twice (via a jump back) records it once', () => {
        let flow = skipStage(startReviewFlow('2026-08-23T09:00:00.000Z'));
        flow = skipStage(jumpToStage(flow, 0));
        expect(flow.skippedStageIds).toEqual(['clearInboxes']);
    });

    it('a skipped stage returned to and worked through is no longer reported as skipped', () => {
        // Skip Next Actions (index 4), jump back, decide an item — the payoff screen must report
        // the decisions, not the stale skip mark.
        let flow = skipStage(jumpToStage(startReviewFlow('2026-08-23T09:00:00.000Z'), 4));
        flow = jumpToStage(flow, 4);
        flow = withStageQueue(flow, 'nextActions', completeCurrentItem(buildStageQueue(['a', 'b'])));
        const stat = reviewStats(flow).find((stage) => stage.stageId === 'nextActions');
        expect(stat).toMatchObject({ processedCount: 1, wasSkipped: false });
    });

    it('toggleInboxTick is symmetric', () => {
        const flow = startReviewFlow('2026-08-23T09:00:00.000Z');
        const ticked = toggleInboxTick(flow, 'ri-1');
        expect(ticked.tickedInboxIds).toEqual(['ri-1']);
        expect(toggleInboxTick(ticked, 'ri-1').tickedInboxIds).toEqual([]);
    });

    it('jumpToStage moves freely in both directions, clamped into the stage range, with no skip marks', () => {
        const flow = jumpToStage(startReviewFlow('2026-08-23T09:00:00.000Z'), 5);
        expect(flow.stageIndex).toBe(5);
        expect(flow.skippedStageIds).toEqual([]);
        expect(jumpToStage(flow, 1).stageIndex).toBe(1);
        expect(jumpToStage(flow, -3).stageIndex).toBe(0);
        expect(jumpToStage(flow, 99).stageIndex).toBe(REVIEW_STAGES.length - 1);
    });

    it('isChecklistComplete requires every listed bucket and ignores stray ticks', () => {
        expect(isChecklistComplete(['ri-1'], ['ri-1'])).toBe(true);
        expect(isChecklistComplete([], ['ri-1'])).toBe(false);
        // Drafts from before the system-inbox row was removed may still carry its sentinel tick.
        expect(isChecklistComplete(['system'], ['ri-1'])).toBe(false);
        expect(isChecklistComplete(['system'], [])).toBe(true);
        expect(isChecklistComplete([], [])).toBe(true);
    });

    it('reviewStats reports per-stage decisions and wholesale skips, excluding the checklist stage', () => {
        let flow = startReviewFlow('2026-08-23T09:00:00.000Z');
        flow = withStageQueue(flow, 'clarify', { pending: [], cursor: 0, decisions: [{ itemId: 'a' }, { itemId: 'b' }, { itemId: 'c' }] });
        flow = { ...flow, skippedStageIds: ['calendar'] };
        const stats = reviewStats(flow);
        expect(stats.some((stage) => stage.stageId === 'clearInboxes')).toBe(false);
        expect(stats.find((stage) => stage.stageId === 'clarify')).toMatchObject({ processedCount: 3, wasSkipped: false });
        expect(stats.find((stage) => stage.stageId === 'calendar')).toMatchObject({ processedCount: 0, wasSkipped: true });
    });
});

describe('stageEligibleEntryIds — calendar routine collapse', () => {
    const routine = makeCalendarRoutine({ _id: 'r1' });
    const occurrences = [
        makeItem({ _id: 'occ1', status: 'calendar', routineId: 'r1', timeStart: '2026-08-27T18:00:00.000Z' }),
        makeItem({ _id: 'occ2', status: 'calendar', routineId: 'r1', timeStart: '2026-09-03T18:00:00.000Z' }),
    ];
    const solo = makeItem({ _id: 'solo', status: 'calendar', timeStart: '2026-08-30T10:00:00.000Z' });

    it('collapses all of a routine occurrences into ONE routine entry, placed at its first occurrence position', () => {
        const entryIds = stageEligibleEntryIds('calendar', [...occurrences, solo], { ...CTX, routines: [routine] });
        expect(entryIds).toEqual([routineEntryId('r1'), 'solo']);
    });

    it('keeps a modified exception as its own entry — only pattern-following occurrences collapse', () => {
        const withException = makeCalendarRoutine({
            _id: 'r1',
            routineExceptions: [{ date: '2026-09-03', type: 'modified', itemId: 'occ2', newTimeStart: '2026-09-04T09:00:00.000Z' }],
        });
        const entryIds = stageEligibleEntryIds('calendar', [...occurrences, solo], { ...CTX, routines: [withException] });
        expect(entryIds).toEqual([routineEntryId('r1'), 'solo', 'occ2']);
    });

    it('a skipped exception does not un-collapse anything (it has no live item)', () => {
        const withSkip = makeCalendarRoutine({ _id: 'r1', routineExceptions: [{ date: '2026-09-03', type: 'skipped' }] });
        const entryIds = stageEligibleEntryIds('calendar', occurrences, { ...CTX, routines: [withSkip] });
        expect(entryIds).toEqual([routineEntryId('r1')]);
    });

    it('items whose routine is unknown on this device stay individual', () => {
        expect(stageEligibleEntryIds('calendar', [...occurrences, solo], CTX)).toEqual(['occ1', 'solo', 'occ2']);
    });

    it('non-calendar stages pass item ids through unchanged — a nextAction routine item is never collapsed', () => {
        const routineNextAction = makeItem({ _id: 'na1', status: 'nextAction', routineId: 'r1' });
        expect(stageEligibleEntryIds('nextActions', [routineNextAction], { ...CTX, routines: [routine] })).toEqual(['na1']);
    });

    it('routineIdOfEntry round-trips entry ids and rejects plain item ids', () => {
        expect(routineIdOfEntry(routineEntryId('r1'))).toBe('r1');
        expect(routineIdOfEntry('occ1')).toBeNull();
    });

    it('sweep counts a routine as ONE seen entry — new occurrences of a reviewed routine are not arrivals', () => {
        const base = startReviewFlow('2026-08-23T00:00:00.000Z');
        // The calendar stage reviewed the collapsed routine entry; a third occurrence generated since.
        const flow = withStageQueue(base, 'calendar', completeCurrentItem(buildStageQueue([routineEntryId('r1')])));
        const lateOccurrence = makeItem({ _id: 'occ3', status: 'calendar', routineId: 'r1', timeStart: '2026-09-10T18:00:00.000Z' });
        expect(unreviewedStageArrivals(flow, [...occurrences, lateOccurrence], { ...CTX, routines: [routine] })).toEqual([]);
    });

    it('sweep still reports a NEW routine the calendar stage never offered', () => {
        const base = startReviewFlow('2026-08-23T00:00:00.000Z');
        const flow = withStageQueue(base, 'calendar', completeCurrentItem(buildStageQueue([routineEntryId('r1')])));
        const otherOccurrence = makeItem({ _id: 'other1', status: 'calendar', routineId: 'r2', timeStart: '2026-09-05T08:00:00.000Z' });
        const routines = [routine, makeCalendarRoutine({ _id: 'r2' })];
        expect(unreviewedStageArrivals(flow, [...occurrences, otherOccurrence], { ...CTX, routines })).toEqual([
            { stageId: 'calendar', title: 'Calendar', count: 1 },
        ]);
    });
});

describe('stageEligibleEntryIds — routine lifecycle edges', () => {
    it('a PAUSED routine never collapses — its surviving past-due occurrences review as plain items', () => {
        const paused = makeCalendarRoutine({ _id: 'r1', active: false });
        const leftover = makeItem({ _id: 'past1', status: 'calendar', routineId: 'r1', timeStart: '2026-08-10T18:00:00.000Z' });
        expect(stageEligibleEntryIds('calendar', [leftover], { ...CTX, routines: [paused] })).toEqual(['past1']);
    });

    it('two interleaved routines each collapse at their OWN first-occurrence position', () => {
        const items = [
            makeItem({ _id: 'r1-a', status: 'calendar', routineId: 'r1', timeStart: '2026-08-27T18:00:00.000Z' }),
            makeItem({ _id: 'r2-a', status: 'calendar', routineId: 'r2', timeStart: '2026-08-28T06:00:00.000Z' }),
            makeItem({ _id: 'r1-b', status: 'calendar', routineId: 'r1', timeStart: '2026-09-03T18:00:00.000Z' }),
            makeItem({ _id: 'r2-b', status: 'calendar', routineId: 'r2', timeStart: '2026-09-04T06:00:00.000Z' }),
        ];
        const routines = [makeCalendarRoutine({ _id: 'r1' }), makeCalendarRoutine({ _id: 'r2' })];
        expect(stageEligibleEntryIds('calendar', items, { ...CTX, routines })).toEqual([routineEntryId('r1'), routineEntryId('r2')]);
    });

    it('a modified exception WITHOUT an itemId un-collapses nothing', () => {
        const routine = makeCalendarRoutine({ _id: 'r1', routineExceptions: [{ date: '2026-09-03', type: 'modified' }] });
        const occurrence = makeItem({ _id: 'occ1', status: 'calendar', routineId: 'r1', timeStart: '2026-09-03T18:00:00.000Z' });
        expect(stageEligibleEntryIds('calendar', [occurrence], { ...CTX, routines: [routine] })).toEqual([routineEntryId('r1')]);
    });

    it('routineIdOfEntry on a bare prefix yields the empty string — matching no routine, never a crash', () => {
        expect(routineIdOfEntry('routine:')).toBe('');
    });

    it('mid-stage reconcile swaps a vanished routine entry for its surviving item ids', () => {
        // The routine row was deleted (e.g. on another device) while its items survived: the
        // pseudo-entry drops out and the plain item ids append to the walk.
        const queue = buildStageQueue([routineEntryId('r1')]);
        const reconciled = reconcileQueue(queue, ['occ1', 'occ2']);
        expect(reconciled.pending).toEqual(['occ1', 'occ2']);
    });

    it('a routine entry round-trips the no-write undo exactly like an item id', () => {
        const decided = completeCurrentItem(buildStageQueue([routineEntryId('r1'), 'solo']), {});
        expect(decidedItemIds(decided)).toEqual([routineEntryId('r1')]);
        const undone = undoDecision(decided, routineEntryId('r1'));
        expect(currentQueueItemId(undone)).toBe(routineEntryId('r1'));
        expect(decidedItemIds(undone)).toEqual([]);
    });
});

describe('isModifiedExceptionItem — matching survives the inbound refresh', () => {
    const occurrences = [
        makeItem({ _id: 'occ1', status: 'calendar', routineId: 'r1', timeStart: '2026-08-27T18:00:00.000Z' }),
        makeItem({ _id: 'occ2', status: 'calendar', routineId: 'r1', timeStart: '2026-09-03T18:00:00.000Z' }),
    ];

    it('GCal-owned per-instance mirrors on EVERY occurrence (attendees, organizer, RSVP…) do NOT break the collapse', () => {
        const noisy = makeCalendarRoutine({
            _id: 'r1',
            routineExceptions: [
                { date: '2026-08-27', type: 'modified', attendees: [], organizer: { email: 'boss@example.com' }, responseStatus: 'accepted' },
                { date: '2026-09-03', type: 'modified', creator: { email: 'boss@example.com' }, eventType: 'default' },
            ],
        });
        expect(stageEligibleEntryIds('calendar', occurrences, { ...CTX, routines: [noisy] })).toEqual([routineEntryId('r1')]);
    });

    it('a title override matches by occurrence date when itemId is absent (the inbound refresh drops it)', () => {
        const renamed = makeCalendarRoutine({ _id: 'r1', routineExceptions: [{ date: '2026-09-03', type: 'modified', title: 'Renamed occurrence' }] });
        expect(stageEligibleEntryIds('calendar', occurrences, { ...CTX, routines: [renamed] })).toEqual([routineEntryId('r1'), 'occ2']);
    });

    it('a time-moved override matches the relocated item VERBATIM — production shapes carry a GCal offset on both sides', () => {
        // The inbound path assigns `timeStart = newTimeStart` verbatim, so the strings are equal.
        const moved = makeCalendarRoutine({
            _id: 'r1',
            routineExceptions: [{ date: '2026-09-03', type: 'modified', newTimeStart: '2026-09-04T09:00:00+03:00' }],
        });
        const relocated = makeItem({ _id: 'occ2', status: 'calendar', routineId: 'r1', timeStart: '2026-09-04T09:00:00+03:00' });
        const [occ1] = occurrences;
        if (!occ1) throw new Error('expected the fixture occurrence');
        expect(stageEligibleEntryIds('calendar', [occ1, relocated], { ...CTX, routines: [moved] })).toEqual([routineEntryId('r1'), 'occ2']);
    });

    it('a floating-local item still matches an offset-carrying newTimeStart by date — never by browser-zone instant math', () => {
        const moved = makeCalendarRoutine({
            _id: 'r1',
            routineExceptions: [{ date: '2026-09-03', type: 'modified', newTimeStart: '2026-09-04T09:00:00+03:00' }],
        });
        const floating = makeItem({ _id: 'occ2', status: 'calendar', routineId: 'r1', timeStart: '2026-09-04T09:00:00' });
        expect(stageEligibleEntryIds('calendar', [floating], { ...CTX, routines: [moved] })).toEqual(['occ2']);
    });

    it('a time-moved override whose item has NOT moved yet stays collapsed — the row follows within one sync', () => {
        const moved = makeCalendarRoutine({
            _id: 'r1',
            routineExceptions: [{ date: '2026-09-03', type: 'modified', newTimeStart: '2026-09-10T09:00:00+03:00' }],
        });
        expect(stageEligibleEntryIds('calendar', occurrences, { ...CTX, routines: [moved] })).toEqual([routineEntryId('r1')]);
    });

    it('a date-keyed override pulls out BOTH occurrences of a twice-daily routine on that date — the key is date-granular by design', () => {
        const renamed = makeCalendarRoutine({ _id: 'r1', routineExceptions: [{ date: '2026-09-03', type: 'modified', title: 'Renamed occurrence' }] });
        const twiceDaily = [
            makeItem({ _id: 'am', status: 'calendar', routineId: 'r1', timeStart: '2026-09-03T09:00:00.000Z' }),
            makeItem({ _id: 'pm', status: 'calendar', routineId: 'r1', timeStart: '2026-09-03T18:00:00.000Z' }),
            makeItem({ _id: 'next', status: 'calendar', routineId: 'r1', timeStart: '2026-09-04T09:00:00.000Z' }),
        ];
        expect(stageEligibleEntryIds('calendar', twiceDaily, { ...CTX, routines: [renamed] })).toEqual(['am', 'pm', routineEntryId('r1')]);
    });
});

describe('normalizeCalendarQueue', () => {
    const routine = makeCalendarRoutine({ _id: 'r1' });
    const occurrences = [
        makeItem({ _id: 'occ1', status: 'calendar', routineId: 'r1', timeStart: '2026-08-27T18:00:00.000Z' }),
        makeItem({ _id: 'occ2', status: 'calendar', routineId: 'r1', timeStart: '2026-09-03T18:00:00.000Z' }),
        makeItem({ _id: 'occ3', status: 'calendar', routineId: 'r1', timeStart: '2026-09-10T18:00:00.000Z' }),
    ];
    const solo = makeItem({ _id: 'solo', status: 'calendar', timeStart: '2026-09-20T10:00:00.000Z' });
    const allItems = [...occurrences, solo];

    it('folds raw occurrence ids persisted by a pre-collapse draft onto the routine entry — pending AND decisions', () => {
        const persisted = {
            pending: ['occ2', 'occ3', 'solo'],
            cursor: 0,
            decisions: [{ itemId: 'occ1', undo: { snapshot: makeItem({ _id: 'occ1', status: 'calendar' }) } }],
        };
        const normalized = normalizeCalendarQueue(persisted, allItems, [routine]);
        // occ1's decision stands for the whole routine now; its single-item snapshot undo is
        // dropped (routine entries are undo-less), and the still-pending occurrences leave the walk.
        expect(decidedItemIds(normalized)).toEqual([routineEntryId('r1')]);
        expect(normalized.decisions[0]?.undo).toBeUndefined();
        expect(normalized.pending).toEqual(['solo']);
    });

    it('folds duplicate decisions — raw occurrences plus an existing routine entry — into one decision', () => {
        const persisted = {
            pending: [],
            cursor: 0,
            decisions: [{ itemId: routineEntryId('r1') }, { itemId: 'occ1' }, { itemId: 'occ2' }, { itemId: 'solo' }],
        };
        const normalized = normalizeCalendarQueue(persisted, allItems, [routine]);
        expect(decidedItemIds(normalized)).toEqual([routineEntryId('r1'), 'solo']);
    });

    it('re-entering the stage after normalization offers each remaining entry exactly once', () => {
        const persisted = { pending: ['occ1', 'occ2', 'occ3', 'solo'], cursor: 0, decisions: [] };
        const normalized = normalizeCalendarQueue(persisted, allItems, [routine]);
        const eligible = stageEligibleEntryIds('calendar', allItems, { ...CTX, routines: [routine] });
        expect(refreshQueueOnEntry(normalized, eligible).pending).toEqual([routineEntryId('r1'), 'solo']);
    });

    it('a routine row missing/inactive at build time collapses MID-STAGE once the active row arrives', () => {
        const stale = makeCalendarRoutine({ _id: 'r1', active: false });
        const built = buildStageQueue(stageEligibleEntryIds('calendar', allItems, { ...CTX, routines: [stale] }));
        expect(built.pending).toEqual(['occ1', 'occ2', 'occ3', 'solo']);
        const eligibleNow = stageEligibleEntryIds('calendar', allItems, { ...CTX, routines: [routine] });
        const reconciled = reconcileQueue(normalizeCalendarQueue(built, allItems, [routine]), eligibleNow);
        expect(reconciled.pending).toEqual([routineEntryId('r1'), 'solo']);
    });

    it('keeps the cursor on the entry the user is looking at while earlier occurrences fold away', () => {
        const persisted = { pending: ['occ1', 'occ2', 'solo'], cursor: 2, decisions: [] };
        const normalized = normalizeCalendarQueue(persisted, allItems, [routine]);
        expect(normalized.pending).toEqual([routineEntryId('r1'), 'solo']);
        expect(currentQueueItemId(normalized)).toBe('solo');
    });

    it('a current entry folding onto an ALREADY-DECIDED one lands on its successor — never silently past unseen entries', () => {
        // Mid-session heal: the routine card was decided, then the stale raw rows normalize while
        // the user is parked on one of them. The cursor must land on 'solo', not walk past it.
        const persisted = { pending: ['occ1', 'occ2', 'occ3', 'solo'], cursor: 2, decisions: [{ itemId: routineEntryId('r1') }] };
        const normalized = normalizeCalendarQueue(persisted, allItems, [routine]);
        expect(normalized.pending).toEqual(['solo']);
        expect(currentQueueItemId(normalized)).toBe('solo');
    });

    it('droppedIds are NOT folded — escaping one occurrence must not suppress (or mark seen) the whole series', () => {
        const persisted = { pending: ['occ2', 'occ3', 'solo'], cursor: 0, decisions: [], droppedIds: ['occ1'] };
        const normalized = normalizeCalendarQueue(persisted, allItems, [routine]);
        expect(normalized.droppedIds).toEqual(['occ1']);
        // The routine entry is still offered mid-stage: the stale raw id in droppedIds matches nothing.
        const eligible = stageEligibleEntryIds('calendar', allItems, { ...CTX, routines: [routine] });
        expect(reconcileQueue(normalized, eligible).pending).toEqual([routineEntryId('r1'), 'solo']);
    });

    it('returns the same reference when the queue is already canonical', () => {
        const canonical = { pending: [routineEntryId('r1'), 'solo'], cursor: 1, decisions: [{ itemId: 'other' }] };
        expect(normalizeCalendarQueue(canonical, allItems, [routine])).toBe(canonical);
    });

    it('leaves a paused routine occurrences raw — normalization never collapses what eligibility would not', () => {
        const paused = makeCalendarRoutine({ _id: 'r1', active: false });
        const persisted = { pending: ['occ1', 'occ2', 'occ3', 'solo'], cursor: 0, decisions: [] };
        expect(normalizeCalendarQueue(persisted, allItems, [paused])).toBe(persisted);
    });
});
