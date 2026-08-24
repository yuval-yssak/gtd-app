import type { IDBPDatabase } from 'idb';
import { useRef, useState } from 'react';
import type { MyDB } from '../../types/MyDB';
import { completeCurrentItem, dropCurrentItem, type StageDecisionUndo, type StageQueue, skipCurrentItem, stepBack } from './reviewFlowState';
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
    const { undoDecisionNow, isUndoing } = useDecisionUndo({ db, onQueueChange, onUndone: () => setBackOffset(0), onUndoFailed });

    /** Records a decision on the current item. `undo` absent = not reversible (see StageDecision). */
    const recordDecision = (undo?: StageDecisionUndo) => onQueueChange((liveQueue) => completeCurrentItem(liveQueue, undo));
    /** Steps past the current item, leaving it undecided — the ▶ arrow and Escape-close behavior. */
    const skip = () => onQueueChange(skipCurrentItem);

    /** ◀ on the live queue: first step back through this walk's skipped items, then into the decisions. */
    function goBack() {
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
              onUndoDecision: () => void undoDecisionNow(revisited),
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
        forward: { onForward: () => onQueueChange(dropCurrentItem), label: 'Skip blocked item', testId },
    });

    return { revisitProps, goBack, canGoBack, skip, recordDecision, armExplicitSave, markSaveCommitted, closeAsDecisionOrSkip, liveNavProps, blockedNavProps };
}
