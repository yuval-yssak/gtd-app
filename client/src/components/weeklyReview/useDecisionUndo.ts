import type { IDBPDatabase } from 'idb';
import { useEffect, useRef, useState } from 'react';
import { useAppData } from '../../contexts/AppDataProvider';
import { updateItem } from '../../db/itemMutations';
import type { MyDB } from '../../types/MyDB';
import { excludeFromLiveAppend, removeDecision, requeueAtCursor, requeueReadiness, type StageDecision, type StageQueue, undoDecision } from './reviewFlowState';

interface DecisionUndoHost {
    db: IDBPDatabase<MyDB>;
    /** Functional: the transform is applied to the LATEST queue, composing with same-tick commits. */
    onQueueChange: (updateQueue: (queue: StageQueue) => StageQueue) => void;
    /** Fired as soon as the undo is committed to the queue bookkeeping — hosts exit the revisit view here. */
    onUndone: () => void;
    /** Restore write failed — nothing changed; surface this to the user (the stage's snackbar). */
    onUndoFailed: (message: string) => void;
}

/**
 * One-click undo for a revisited stage decision: restores the pre-decision snapshot (when one was
 * captured) and returns the item to the cursor position, so it renders as the current item again.
 *
 * The queue bookkeeping is split in two phases. The decision leaves the history as soon as the
 * restore write lands (still inside the click's own render closure); only the requeue is
 * deferred, until the restored row is visible in the shared items snapshot — requeueing against
 * the stale snapshot would let the wizard's mid-stage reconcile drop the id as ineligible (its
 * status still reads as the decided one). During the gap the id is parked on the live-append
 * exclusion list, so the reconcile can't re-offer it at the END of the walk before the requeue
 * places it at the cursor. If the stage unmounts mid-undo (stepper jump, browser back), no queue
 * change is applied at all: the stale
 * closure's `onQueueChange` would resurrect the old stage index, so instead the decision simply
 * stays in the history with the data already restored, and clicking Undo again on re-entry
 * completes it idempotently. Nothing is ever silently lost.
 */
export function useDecisionUndo({ db, onQueueChange, onUndone, onUndoFailed }: DecisionUndoHost) {
    const { allItems, refreshItems } = useAppData();
    const [awaitedRequeue, setAwaitedRequeue] = useState<{ itemId: string; restoredTs: string } | null>(null);
    // effect body (not just initializer) sets true so a StrictMode remount re-arms after the
    // spurious first cleanup flipped it false.
    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    useEffect(() => {
        if (!awaitedRequeue) {
            return;
        }
        const readiness = requeueReadiness(
            allItems.find((item) => item._id === awaitedRequeue.itemId),
            awaitedRequeue.restoredTs,
        );
        if (readiness === 'wait') {
            return;
        }
        setAwaitedRequeue(null);
        if (readiness === 'requeue') {
            onQueueChange((liveQueue) => requeueAtCursor(liveQueue, awaitedRequeue.itemId));
        }
    }, [allItems, awaitedRequeue, onQueueChange]);

    async function undoDecisionNow(decision: StageDecision) {
        if (!decision.undo) {
            return; // not reversible — the button never renders for these, but guard anyway
        }
        const { snapshot } = decision.undo;
        if (!snapshot) {
            // No write to reverse — the one-step requeue is the whole undo, and the unchanged row
            // is already visible, so no deferral is needed.
            onQueueChange((liveQueue) => undoDecision(liveQueue, decision.itemId));
            onUndone();
            return;
        }
        try {
            const restored = await updateItem(db, snapshot);
            // Phase 1 AFTER the write succeeded — a failed write then rolls back nothing. The
            // mounted guard keeps a stale wizard closure from applying queue changes post-unmount
            // (see the hook doc); the decision then stays undo-able with the data already restored.
            if (!isMountedRef.current) {
                return;
            }
            onQueueChange((liveQueue) => excludeFromLiveAppend(removeDecision(liveQueue, decision.itemId), decision.itemId));
            onUndone();
            setAwaitedRequeue({ itemId: decision.itemId, restoredTs: restored.updatedTs });
            await refreshItems();
        } catch (err) {
            console.error('[weekly-review] undo restore failed:', err);
            onUndoFailed('Could not undo — the item was left as decided.');
        }
    }

    return { undoDecisionNow, isUndoing: awaitedRequeue !== null };
}
