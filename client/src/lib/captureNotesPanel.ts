/** State of the collapsible notes panel under a capture field (inbox page + quick-capture FAB). */
export interface CaptureNotesPanelState {
    isOpen: boolean;
    tab: 0 | 1;
    /** Only an explicit "Add note" click moves focus into the editor — a restored draft that
     *  reopens the panel must not steal focus from the title field. */
    shouldFocusEditor: boolean;
}

export type CaptureNotesPanelAction =
    | { type: 'toggledByUser' }
    | { type: 'restoredFromDraft' }
    | { type: 'tabSelected'; tab: 0 | 1 }
    | { type: 'pendingFocusCancelled' }
    | { type: 'captured' };

export const INITIAL_CAPTURE_NOTES_PANEL: CaptureNotesPanelState = { isOpen: false, tab: 0, shouldFocusEditor: false };

export function captureNotesPanelReducer(state: CaptureNotesPanelState, action: CaptureNotesPanelAction): CaptureNotesPanelState {
    switch (action.type) {
        case 'toggledByUser':
            // Opening lands on the Edit tab so the editor mounts and can take focus.
            return state.isOpen ? { ...state, isOpen: false, shouldFocusEditor: false } : { isOpen: true, tab: 0, shouldFocusEditor: true };
        case 'restoredFromDraft':
            return { ...state, isOpen: true, shouldFocusEditor: false };
        case 'tabSelected':
            return { ...state, tab: action.tab };
        case 'pendingFocusCancelled':
            return { ...state, shouldFocusEditor: false };
        case 'captured':
            return INITIAL_CAPTURE_NOTES_PANEL;
    }
}
