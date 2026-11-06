// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    buildStageQueue,
    completeCurrentItem,
    currentQueueItemId,
    decidedItemIds,
    reconcileQueue,
    type StageQueue,
    skipCurrentItem,
} from '../components/weeklyReview/reviewFlowState';
import { useStageDecisionNavigation } from '../components/weeklyReview/useStageDecisionNavigation';
import { AppDataContext } from '../contexts/AppDataProvider';
import { buildMockAppData } from '../test-utils/storybookAppData';
import type { MyDB } from '../types/MyDB';
import { openTestDB } from './openTestDB';

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    db = await openTestDB();
});

afterEach(() => {
    cleanup();
    db.close();
});

/**
 * The hook as a stage hosts it: `renderedQueue` is what the stage last rendered with, while the
 * live queue (what `onQueueChange` updaters run against) may have moved on since — exactly the gap
 * a reconcile opens between a write and the decision it records.
 */
function renderDecisionNavigation(renderedQueue: StageQueue, liveQueue: StageQueue, revisitOffset = 0) {
    const live = { queue: liveQueue, revisitOffsets: [] as number[] };
    const appData = buildMockAppData();
    const { result } = renderHook(
        () =>
            useStageDecisionNavigation({
                db,
                queue: renderedQueue,
                onQueueChange: (updateQueue) => {
                    live.queue = updateQueue(live.queue);
                },
                onUndoFailed: () => {},
                revisit: { offset: revisitOffset, onOffsetChange: (offset) => live.revisitOffsets.push(offset) },
            }),
        { wrapper: ({ children }) => <AppDataContext.Provider value={appData}>{children}</AppDataContext.Provider> },
    );
    return { nav: () => result.current, live };
}

describe('useStageDecisionNavigation', () => {
    // The pause made the gym entry ineligible and the reconcile already dropped it — the decision
    // must still land on the gym, not on the Pool card that became current meanwhile.
    it('records a decision on the entry acted on, even after a reconcile moved the cursor past it', () => {
        const rendered = buildStageQueue(['routine:gym', 'routine:pool', 'exception']);
        const { nav, live } = renderDecisionNavigation(rendered, reconcileQueue(rendered, ['routine:pool', 'exception']));

        act(() => nav().recordDecision({ itemId: 'routine:gym' }));

        expect(decidedItemIds(live.queue)).toEqual(['routine:gym']);
        expect(currentQueueItemId(live.queue)).toBe('routine:pool');
    });

    it('a post-save close decides the closing editor’s own item, never the one the cursor moved to', () => {
        const rendered = buildStageQueue(['a', 'b']);
        const { nav, live } = renderDecisionNavigation(rendered, skipCurrentItem(rendered));

        act(() => {
            nav().armExplicitSave({ undo: {} }, () => {});
            nav().markSaveCommitted();
            nav().closeAsDecisionOrSkip('a');
        });

        expect(decidedItemIds(live.queue)).toEqual(['a']);
        expect(live.queue.pending).toEqual(['b']);
        expect(currentQueueItemId(live.queue)).toBe('b');
    });

    it('a routine card’s save handshake records the occurrence it was showing', () => {
        const rendered = buildStageQueue(['routine:gym']);
        const { nav, live } = renderDecisionNavigation(rendered, rendered);

        act(() => {
            nav().armExplicitSave({ occurrenceId: 'occ-1' }, () => {});
            nav().markSaveCommitted();
            nav().closeAsDecisionOrSkip('routine:gym');
        });

        expect(live.queue.decisions).toEqual([{ itemId: 'routine:gym', occurrenceId: 'occ-1' }]);
    });

    // The revisit offset is owned by the wizard (its header counter reads it), so the hook only
    // reads it and reports moves.
    it('reads the revisit position from its host and reports ◀ / ▶ moves back to it', () => {
        const decided = completeCurrentItem(completeCurrentItem(buildStageQueue(['a', 'b'])));
        const { nav, live } = renderDecisionNavigation(decided, decided, 1);

        const revisit = nav().revisitProps;
        if (!revisit) throw new Error('expected the revisit view at offset 1');
        expect(revisit.decision.itemId).toBe('b');
        act(() => revisit.onGoBack());
        act(() => revisit.onGoForward());
        act(() => nav().goBack());

        expect(live.revisitOffsets).toEqual([2, 0, 1]);
    });
});
