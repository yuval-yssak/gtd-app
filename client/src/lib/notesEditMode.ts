import { notesAreEmpty } from '../components/itemEditor/itemEditorLogic';

/**
 * The editor's notes: preview vs editor, plus whether the editor should take focus when it mounts.
 * The focus request lives in state for the whole edit session (not a ref consumed during render):
 * the CodeMirror view is lazy-loaded and reads `autoFocus` only when IT mounts, so a re-render of
 * the section while the chunk loads must still pass `true`.
 */
export interface NotesEditMode {
    isEditing: boolean;
    focusEditorOnMount: boolean;
}

/** Empty notes have nothing to preview, so the editor is the resting state — without stealing focus on open. */
export const initialNotesEditMode = (notes: string): NotesEditMode => ({ isEditing: notesAreEmpty(notes), focusEditorOnMount: false });

export const enterNotesEdit = (): NotesEditMode => ({ isEditing: true, focusEditorOnMount: true });

export const exitNotesEdit = (): NotesEditMode => ({ isEditing: false, focusEditorOnMount: false });
