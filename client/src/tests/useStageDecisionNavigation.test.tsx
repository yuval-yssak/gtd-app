// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    buildStageQueue,
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
function renderDecisionNavigation(renderedQueue: StageQueue, liveQueue: StageQueue) {
    const live = { queue: liveQueue };
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

        act(() => nav().recordDecision('routine:gym'));

        expect(decidedItemIds(live.queue)).toEqual(['routine:gym']);
        expect(currentQueueItemId(live.queue)).toBe('routine:pool');
    });

    it('a post-save close decides the closing editor’s own item, never the one the cursor moved to', () => {
        const rendered = buildStageQueue(['a', 'b']);
        const { nav, live } = renderDecisionNavigation(rendered, skipCurrentItem(rendered));

        act(() => {
            nav().armExplicitSave({}, () => {});
            nav().markSaveCommitted();
            nav().closeAsDecisionOrSkip('a');
        });

        expect(decidedItemIds(live.queue)).toEqual(['a']);
        expect(live.queue.pending).toEqual(['b']);
        expect(currentQueueItemId(live.queue)).toBe('b');
    });
});
