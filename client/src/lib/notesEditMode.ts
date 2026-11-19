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

/**
 * Where empty notes rest. `editor` (the item page): with nothing to preview, an open writing surface
 * makes the affordance obvious. `header` (the review card): the label and its pencil alone, because
 * a scanning card cannot spare an empty editor's height.
 */
export type EmptyNotesRestingState = 'editor' | 'header';

/** Non-empty notes rest in the preview; empty ones per `emptyRest` — never stealing focus on open. */
export const initialNotesEditMode = (notes: string, emptyRest: EmptyNotesRestingState = 'editor'): NotesEditMode => ({
    isEditing: emptyRest === 'editor' && notesAreEmpty(notes),
    focusEditorOnMount: false,
});

export const enterNotesEdit = (): NotesEditMode => ({ isEditing: true, focusEditorOnMount: true });

export const exitNotesEdit = (): NotesEditMode => ({ isEditing: false, focusEditorOnMount: false });
