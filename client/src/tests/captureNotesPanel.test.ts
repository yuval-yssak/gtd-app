import { describe, expect, it } from 'vitest';
import { type CaptureNotesPanelState, captureNotesPanelReducer, INITIAL_CAPTURE_NOTES_PANEL } from '../lib/captureNotesPanel';

describe('captureNotesPanelReducer', () => {
    it('an "Add note" click opens on the Edit tab and requests editor focus', () => {
        const onPreview: CaptureNotesPanelState = { isOpen: false, tab: 1, shouldFocusEditor: false };
        expect(captureNotesPanelReducer(onPreview, { type: 'toggledByUser' })).toEqual({ isOpen: true, tab: 0, shouldFocusEditor: true });
    });

    it('a second click closes the panel and drops the focus request', () => {
        const open = captureNotesPanelReducer(INITIAL_CAPTURE_NOTES_PANEL, { type: 'toggledByUser' });
        expect(captureNotesPanelReducer(open, { type: 'toggledByUser' })).toMatchObject({ isOpen: false, shouldFocusEditor: false });
    });

    it('a restored draft opens the panel without stealing focus', () => {
        expect(captureNotesPanelReducer(INITIAL_CAPTURE_NOTES_PANEL, { type: 'restoredFromDraft' })).toEqual({
            isOpen: true,
            tab: 0,
            shouldFocusEditor: false,
        });
    });

    it('cancelling the pending focus keeps the panel open', () => {
        const open = captureNotesPanelReducer(INITIAL_CAPTURE_NOTES_PANEL, { type: 'toggledByUser' });
        expect(captureNotesPanelReducer(open, { type: 'pendingFocusCancelled' })).toEqual({ isOpen: true, tab: 0, shouldFocusEditor: false });
    });

    it('capturing resets everything', () => {
        const open = captureNotesPanelReducer(INITIAL_CAPTURE_NOTES_PANEL, { type: 'toggledByUser' });
        expect(captureNotesPanelReducer(open, { type: 'captured' })).toEqual(INITIAL_CAPTURE_NOTES_PANEL);
    });

    it('a draft restore landing after an "Add note" click drops the focus request but keeps the tab', () => {
        const openOnPreview: CaptureNotesPanelState = { isOpen: true, tab: 1, shouldFocusEditor: true };
        expect(captureNotesPanelReducer(openOnPreview, { type: 'restoredFromDraft' })).toEqual({ isOpen: true, tab: 1, shouldFocusEditor: false });
    });

    it('switching tabs keeps the focus request so returning to Edit focuses the remounted editor', () => {
        const open = captureNotesPanelReducer(INITIAL_CAPTURE_NOTES_PANEL, { type: 'toggledByUser' });
        expect(captureNotesPanelReducer(open, { type: 'tabSelected', tab: 1 })).toEqual({ isOpen: true, tab: 1, shouldFocusEditor: true });
    });
});
