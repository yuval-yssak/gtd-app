import type { IDBPDatabase } from 'idb';
import { useRef, useState } from 'react';
import type { MyDB } from '../../types/MyDB';
import {
    completeCurrentItem,
    dropCurrentItem,
    type RevisitResume,
    type StageDecisionUndo,
    type StageQueue,
    shouldResumeRevisit,
    skipCurrentItem,
    stepBack,
} from './reviewFlowState';
import { useDecisionUndo } from './useDecisionUndo';

interface StageDecisionNavigationHost {
    db: IDBPDatabase<MyDB>;
    queue: StageQueue;
    /** Functional: the transform is applied to the LATEST queue, composing with same-tick commits. */
    onQueueChange: (updateQueue: (queue: StageQueue) => StageQueue) => void;
    /** Undo restore failed — nothing changed; the stage surfaces this through its snackbar. */
    onUndoFailed: (message: string) => void;
}

/**
 * Everything the two solo stages (clarify + focus) share about deciding, deferring, and
 * revisiting: the explicit-save decision handshake with ItemEditorBody (onSaveCommitted →
 * onClose), the ◀ revisit offset with one-click undo, and the ▶ defer / blocked-drop arrow
 * props. The stages keep only their genuinely different parts — the decision buttons and their
 * mutations.
 */
export function useStageDecisionNavigation({ db, queue, onQueueChange, onUndoFailed }: StageDecisionNavigationHost) {
    // Whether the CURRENT item committed an EXPLICIT save (onSaveCommitted). ItemEditorBody fires
    // onClose from the save path, from page-chrome Escape, and from its reassign-in-flight branch —
    // only an explicit save is a review decision. Deliberately NOT set from onSaved: a debounced
    // text-autosave commit (which can land after advancing, via the unmount flush) also fires
    // onSaved, and inferring "saved" from it would turn a later Escape into a phantom decision.
    const savedRef = useRef(false);
    // Undo payload captured when "Save & next" is clicked, consumed by the post-save onClose so
    // the recorded decision can restore what the item looked like before the save.
    const pendingSaveUndoRef = useRef<StageDecisionUndo | undefined>(undefined);
    // How far back the user is looking: 0 = live queue, n = the n-th most recent decision.
    const [backOffset, setBackOffset] = useState(0);
    // Armed when Undo exits to the live queue (the requeued item must render live to be
    // re-decided): re-deciding THAT item returns the walk to the same chronological revisit
    // position — same "p of N" label, ◀ continues into older decisions — instead of forgetting
    // the position and landing at the stage end. Any other move in between (skip, ◀, a blocked
    // drop, a failed undo) abandons the resume.
    const resumeRevisitRef = useRef<RevisitResume | null>(null);
    const { undoDecisionNow, isUndoing } = useDecisionUndo({
        db,
        onQueueChange,
        onUndone: () => setBackOffset(0),
        onUndoFailed: (message) => {
            resumeRevisitRef.current = null;
            onUndoFailed(message);
        },
    });

    /** Records a decision on the current item. `undo` absent = not reversible (see StageDecision). */
    const recordDecision = (undo?: StageDecisionUndo) => {
        const resume = resumeRevisitRef.current;
        resumeRevisitRef.current = null;
        // `let` + resolve-inside-the-updater: the render-captured `queue` can be several async
        // ticks stale when this runs from the save handshake's post-await close (the in-flight
        // transition holds the old closure), so the resumed-item check must read the LIVE queue.
        // Load-bearing: onQueueChange invokes the updater synchronously (weekly-review.tsx applies
        // it inline against latestFlowRef), so `didResume` is set before the check below.
        let didResume = false;
        onQueueChange((liveQueue) => {
            didResume = shouldResumeRevisit(resume, liveQueue);
            return completeCurrentItem(liveQueue, undo);
        });
        // The re-decided entry re-enters the history at its END, so the stored offset now points
        // at the old position's chronological successor — exactly the same "p of N" slot.
        if (resume && didResume) {
            setBackOffset(resume.offset);
        }
    };
    /** Steps past the current item, leaving it undecided — the ▶ arrow and Escape-close behavior. */
    const skip = () => {
        resumeRevisitRef.current = null;
        onQueueChange(skipCurrentItem);
    };

    /** ◀ on the live queue: first step back through this walk's skipped items, then into the decisions. */
    function goBack() {
        resumeRevisitRef.current = null;
        // The branch reads the render-captured cursor, but the mutation is functional and
        // stepBack no-ops at 0 — a same-tick cursor change costs at most one dead click, never a
        // step below the start.
        if (queue.cursor > 0) {
            onQueueChange(stepBack);
            return;
        }
        setBackOffset(1);
    }
    const canGoBack = queue.cursor > 0 || queue.decisions.length > 0;
    const backLabel = queue.cursor > 0 ? 'Back to the skipped item' : 'Revisit previous decision';

    // Clamp against the live history — an undo may have shrunk it below the stored offset.
    const revisitOffset = Math.min(backOffset, queue.decisions.length);
    const revisited = revisitOffset > 0 ? queue.decisions[queue.decisions.length - revisitOffset] : undefined;

    /** Props for RevisitDecisionCard while looking backward; null on the live queue. */
    const revisitProps = revisited
        ? {
              decision: revisited,
              position: { index: queue.decisions.length - revisitOffset + 1, total: queue.decisions.length },
              canGoBack: revisitOffset < queue.decisions.length,
              onGoBack: () => setBackOffset(revisitOffset + 1),
              onGoForward: () => setBackOffset(revisitOffset - 1),
              onUndoDecision: () => {
                  // Captured BEFORE the undo resets the walk to the live queue (onUndone).
                  resumeRevisitRef.current = { itemId: revisited.itemId, offset: revisitOffset };
                  void undoDecisionNow(revisited);
              },
              isUndoing,
              onExit: () => setBackOffset(0),
          }
        : null;

    /** Arm the explicit-save decision handshake, then hand control to the editor's save path. */
    function armExplicitSave(undo: StageDecisionUndo | undefined, triggerSave: () => void) {
        pendingSaveUndoRef.current = undo;
        triggerSave();
    }

    /** ItemEditorBody's onSaveCommitted — half of the handshake armExplicitSave started. */
    const markSaveCommitted = () => {
        savedRef.current = true;
    };

    /**
     * ItemEditorBody's onClose: a close following an explicit save records the decision (with the
     * armed undo payload); any other close (page-chrome Escape, reassign kickoff) is NOT a
     * decision — the walk steps past the item, leaving it undecided.
     */
    function closeAsDecisionOrSkip() {
        if (savedRef.current) {
            savedRef.current = false;
            const undo = pendingSaveUndoRef.current;
            pendingSaveUndoRef.current = undefined;
            recordDecision(undo);
            return;
        }
        skip();
    }

    /** StageNavButtons props for the live editor's action row. */
    const liveNavProps = (isSaving: boolean) => ({
        onBack: goBack,
        backDisabled: !canGoBack || isSaving,
        backLabel,
        // ▶ is always available on a live item: past the last one it lands on the stage-end card
        // (the walk ends there — it never cycles back to the beginning).
        forward: { onForward: skip, disabled: isSaving, label: 'Skip for now' },
    });

    /**
     * StageNavButtons props for the reassign-blocked fallback: ItemEditorBody early-returns its
     * in-flight notice and portals nothing, so the bar owns this ▶, which DROPS the blocked item
     * (dropCurrentItem) — unlike a skip it doesn't stay in the walk, so re-entry re-offers it.
     */
    const blockedNavProps = (testId: string) => ({
        onBack: goBack,
        backDisabled: !canGoBack,
        backLabel,
        forward: {
            onForward: () => {
                resumeRevisitRef.current = null;
                onQueueChange(dropCurrentItem);
            },
            label: 'Skip blocked item',
            testId,
        },
    });

    return { revisitProps, goBack, canGoBack, skip, recordDecision, armExplicitSave, markSaveCommitted, closeAsDecisionOrSkip, liveNavProps, blockedNavProps };
}
