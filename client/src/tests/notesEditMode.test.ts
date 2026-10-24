import { describe, expect, it } from 'vitest';
import { enterNotesEdit, exitNotesEdit, initialNotesEditMode } from '../lib/notesEditMode';

describe('notes edit mode', () => {
    it('empty notes rest in the editor without pulling focus into it', () => {
        expect(initialNotesEditMode('   ')).toEqual({ isEditing: true, focusEditorOnMount: false });
    });

    it('non-empty notes rest in the preview', () => {
        expect(initialNotesEditMode('Hello')).toEqual({ isEditing: false, focusEditorOnMount: false });
    });

    it('entering edit requests editor focus', () => {
        expect(enterNotesEdit()).toEqual({ isEditing: true, focusEditorOnMount: true });
    });

    it('leaving edit clears the focus request for the next session', () => {
        expect(exitNotesEdit()).toEqual({ isEditing: false, focusEditorOnMount: false });
    });
});
