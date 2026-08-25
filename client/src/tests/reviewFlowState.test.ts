import { describe, expect, it } from 'vitest';
import {
    advanceStage,
    buildStageQueue,
    completeCurrentItem,
    currentQueueItemId,
    currentStage,
    decidedItemIds,
    dropCurrentItem,
    excludeFromLiveAppend,
    isChecklistComplete,
    isFlowComplete,
    jumpToStage,
    REVIEW_STAGES,
    reconcileQueue,
    refreshQueueOnEntry,
    removeDecision,
    requeueAtCursor,
    requeueReadiness,
    reviewStats,
    skipCurrentItem,
    skipStage,
    stageEligibleItems,
    stageEndTitle,
    startReviewFlow,
    stepBack,
    toggleInboxTick,
    undoDecision,
    unreviewedStageArrivals,
    withStageQueue,
} from '../components/weeklyReview/reviewFlowState';
import type { StoredItem } from '../types/MyDB';

const TODAY = '2026-08-23';
const CTX = { todayIso: TODAY, personNameById: { 'p-alice': 'Alice', 'p-bob': 'Bob' } };

function makeItem(overrides: Partial<StoredItem> & { _id: string; status: StoredItem['status'] }): StoredItem {
    return { userId: 'user-1', title: overrides._id, createdTs: '2026-01-01T00:00:00.000Z', updatedTs: '2026-01-01T00:00:00.000Z', ...overrides };
}

describe('stageEligibleItems', () => {
    it('clarify and finalSweep take inbox items newest-first (LIFO), matching the inbox page', () => {
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

    it('nextActions excludes tickler-hidden items; tickler takes exactly those', () => {
        const items = [
            makeItem({ _id: 'visible', status: 'nextAction' }),
            makeItem({ _id: 'boundary', status: 'nextAction', ignoreBefore: TODAY }),
            makeItem({ _id: 'snoozed', status: 'nextAction', ignoreBefore: '2026-09-15' }),
            makeItem({ _id: 'snoozedWait', status: 'waitingFor', ignoreBefore: '2026-09-01' }),
            // Focus does NOT override the tickler gate — a snoozed focus item stays hidden.
            makeItem({ _id: 'snoozedFocus', status: 'nextAction', focus: true, ignoreBefore: '2026-09-15' }),
        ];
        // ignoreBefore === today is visible (the tickler gate is strict >), matching /next-actions.
        expect(stageEligibleItems('nextActions', items, CTX).map((item) => item._id)).toEqual(['visible', 'boundary']);
        expect(stageEligibleItems('tickler', items, CTX).map((item) => item._id)).toEqual(['snoozedWait', 'snoozed', 'snoozedFocus']);
    });

    it('nextActions mirrors the Next Actions page order: focus first, then expectedBy tiers', () => {
        const items = [
            makeItem({ _id: 'plainUndated', status: 'nextAction' }),
            makeItem({ _id: 'plainDated', status: 'nextAction', expectedBy: '2026-09-10' }),
            makeItem({ _id: 'focusUndated', status: 'nextAction', focus: true }),
            makeItem({ _id: 'focusDated', status: 'nextAction', focus: true, expectedBy: '2026-09-20' }),
            makeItem({ _id: 'focusSooner', status: 'nextAction', focus: true, expectedBy: '2026-08-25' }),
        ];
        expect(stageEligibleItems('nextActions', items, CTX).map((item) => item._id)).toEqual([
            'focusSooner',
            'focusDated',
            'focusUndated',
            'plainDated',
            'plainUndated',
        ]);
    });

    it('waitingFor mirrors the page default: person groups A→Z, Unassigned last, expectedBy (undated first) within each group', () => {
        const items = [
            makeItem({ _id: 'bobLater', status: 'waitingFor', waitingForPersonId: 'p-bob', expectedBy: '2026-09-10' }),
            makeItem({ _id: 'unassignedSoon', status: 'waitingFor', expectedBy: '2026-08-25' }),
            makeItem({ _id: 'aliceUndated', status: 'waitingFor', waitingForPersonId: 'p-alice' }),
            makeItem({ _id: 'bobSoon', status: 'waitingFor', waitingForPersonId: 'p-bob', expectedBy: '2026-08-25' }),
            makeItem({ _id: 'unassignedUndated', status: 'waitingFor' }),
            makeItem({ _id: 'hidden', status: 'waitingFor', waitingForPersonId: 'p-alice', ignoreBefore: '2026-12-01' }),
        ];
        expect(stageEligibleItems('waitingFor', items, CTX).map((item) => item._id)).toEqual([
            'aliceUndated',
            'bobSoon',
            'bobLater',
            'unassignedUndated',
            'unassignedSoon',
        ]);
    });

    it('somedayMaybe takes all somedayMaybe items regardless of tickler, newest-first like the someday page', () => {
        const items = [
            makeItem({ _id: 'parked', status: 'somedayMaybe', ignoreBefore: '2027-01-01', createdTs: '2026-01-01T00:00:00.000Z' }),
            makeItem({ _id: 'plain', status: 'somedayMaybe', createdTs: '2026-02-01T00:00:00.000Z' }),
        ];
        expect(stageEligibleItems('somedayMaybe', items, CTX).map((item) => item._id)).toEqual(['plain', 'parked']);
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

    it('a dropped id is re-offered on stage re-entry (undecided, no longer queued → newcomer)', () => {
        const dropped = dropCurrentItem(buildStageQueue(['blocked', 'next']));
        expect(refreshQueueOnEntry(dropped, ['blocked', 'next']).pending).toEqual(['next', 'blocked']);
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
        expect(reentered.pending).toEqual(['b', 'a']);
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

    it('entry refresh restarts the walk at the first undecided item (cursor 0), keeping order', () => {
        // The walk ended with 'a' and 'b' skipped past — re-entering the stage re-offers them
        // from the top plus the newcomer, instead of resuming past the end.
        const ended = skipCurrentItem(skipCurrentItem(buildStageQueue(['a', 'b'])));
        const refreshed = refreshQueueOnEntry(ended, ['a', 'b', 'd']);
        expect(refreshed.pending).toEqual(['a', 'b', 'd']);
        expect(currentQueueItemId(refreshed)).toBe('a');
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
