import { useMemo, useReducer } from 'react';
import { captureNotesPanelReducer, INITIAL_CAPTURE_NOTES_PANEL } from '../lib/captureNotesPanel';

/** Notes panel under a capture field — shared by the inbox page and the quick-capture FAB. */
export function useCaptureNotesPanel() {
    const [panel, dispatch] = useReducer(captureNotesPanelReducer, INITIAL_CAPTURE_NOTES_PANEL);
    // Memoized so the callbacks are stable effect dependencies (dispatch itself never changes).
    const actions = useMemo(
        () => ({
            toggleByUser: () => dispatch({ type: 'toggledByUser' }),
            openForRestoredDraft: () => dispatch({ type: 'restoredFromDraft' }),
            selectTab: (tab: 0 | 1) => dispatch({ type: 'tabSelected', tab }),
            cancelPendingFocus: () => dispatch({ type: 'pendingFocusCancelled' }),
            resetAfterCapture: () => dispatch({ type: 'captured' }),
        }),
        [],
    );
    return { ...panel, ...actions };
}
