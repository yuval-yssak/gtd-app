import { Check, ChevronDown, Pencil } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Button, IconButton, Text } from '../../designSystem';
import { enterNotesEdit, exitNotesEdit, initialNotesEditMode } from '../../lib/notesEditMode';
import { notesAreEmpty } from '../editItemDialogLogic';
import { MarkdownNotesEditor, NOTES_EDITOR_LABEL, NOTES_PLACEHOLDER } from '../markdown/MarkdownNotesEditor';
import { MarkdownPreview } from '../markdown/MarkdownPreview';
import styles from './ItemEditorBody.module.css';

interface NotesSectionProps {
    notes: string;
    onNotesChange: (next: string) => void;
    /**
     * Review presentation with a brief on show: the notes start folded behind a "Show notes"
     * disclosure (the brief already says what the item is) and expand in place on demand.
     */
    collapsible?: boolean | undefined;
}

/**
 * Notes editor section. Defaults to a read-only Markdown preview when notes exist; only the pencil
 * button switches to a focused CodeMirror editor (edits autosave through `onNotesChange`). The
 * "Done" button, Escape, or moving focus elsewhere return to the preview while notes are
 * non-empty. Empty notes start in the editor so the affordance is obvious.
 */
export function NotesSection({ notes, onNotesChange, collapsible = false }: NotesSectionProps) {
    // Hook first, then the disclosure guard: the early return below must not change hook order.
    const [isExpanded, setIsExpanded] = useState(false);
    if (collapsible && !isExpanded) {
        return (
            <div>
                <Button size="sm" tone="neutral" startIcon={<ChevronDown />} onClick={() => setIsExpanded(true)} data-testid="showNotesButton">
                    Show notes
                </Button>
            </div>
        );
    }
    return <PageNotesSection notes={notes} onNotesChange={onNotesChange} />;
}

function PageNotesSection({ notes, onNotesChange }: { notes: string; onNotesChange: (n: string) => void }) {
    // Empty notes start in the editor so the user sees a clear writing surface; non-empty notes
    // start in preview so the page reads like a document. Only the pencil asks for editor focus —
    // a freshly opened item with empty notes must not yank focus (see notesEditMode).
    const [{ isEditing: editing, focusEditorOnMount }, setEditMode] = useState(() => initialNotesEditMode(notes));
    // Per-instance id for the section label's aria-labelledby — useId guarantees uniqueness if
    // the section ever renders more than once in a tree (split pane, side-by-side comparison).
    const labelId = useId();
    // The editor's Escape/blur callbacks read notes through a ref so they always see the latest
    // value even though CodeMirror captures them once at mount.
    const notesRef = useRef(notes);
    notesRef.current = notes;
    // Done/Escape are explicit exits that unmount the focused editor — hand focus to the pencil so
    // keyboard users can re-enter without tabbing back. Blur exits leave focus where the user put it.
    const editButtonRef = useRef<HTMLButtonElement | null>(null);
    const focusEditButtonOnPreviewMount = useRef(false);
    useEffect(() => {
        if (!editing && focusEditButtonOnPreviewMount.current) {
            focusEditButtonOnPreviewMount.current = false;
            editButtonRef.current?.focus();
        }
    }, [editing]);
    const enterEdit = () => setEditMode(enterNotesEdit());
    // Empty notes have nothing to preview — the editor stays the resting state.
    const exitEditIfNotesExist = () => {
        if (notesAreEmpty(notesRef.current)) {
            return false;
        }
        setEditMode(exitNotesEdit());
        return true;
    };
    const exitEditExplicitly = () => {
        const didExit = exitEditIfNotesExist();
        focusEditButtonOnPreviewMount.current = didExit;
        return didExit;
    };

    if (editing) {
        return (
            <div>
                <div className={styles.notesHeader}>
                    <Text as="span" variant="caption" tone="secondary" weight="semibold" id={labelId} className={styles.notesLabel}>
                        {NOTES_EDITOR_LABEL}
                    </Text>
                    {/* Always rendered (disabled while empty) so the header doesn't jump when the
                        first character is typed. */}
                    <IconButton
                        size="sm"
                        aria-label="Done editing notes"
                        disabled={notesAreEmpty(notes)}
                        // Keep focus in the editor on press: otherwise its blur flips to preview
                        // first and the click would land on nothing (or re-enter edit).
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={exitEditExplicitly}
                    >
                        <Check />
                    </IconButton>
                </div>
                <MarkdownNotesEditor
                    value={notes}
                    onValueChange={onNotesChange}
                    placeholder={NOTES_PLACEHOLDER}
                    autoFocus={focusEditorOnMount}
                    onBlurOutside={exitEditIfNotesExist}
                    // First ESC steps out to the preview; claiming the key (return true) makes
                    // CodeMirror preventDefault so the page-level ESC listener doesn't also navigate
                    // back. With empty notes the editor is the resting state — ESC falls through.
                    onEscape={exitEditExplicitly}
                />
            </div>
        );
    }

    // The preview is read-only: selecting text and following links must never flip it into the
    // editor — the pencil is the only way in. It stays focusable so keyboard users can scroll
    // long notes inside the capped-height region.
    return (
        <div>
            <div className={styles.notesHeader}>
                <Text as="span" variant="caption" tone="secondary" weight="semibold" id={labelId} className={styles.notesLabel}>
                    {NOTES_EDITOR_LABEL}
                </Text>
                <IconButton ref={editButtonRef} size="sm" aria-label="Edit notes" onClick={enterEdit}>
                    <Pencil />
                </IconButton>
            </div>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable so keyboard users can scroll long notes (WCAG scrollable-region-focusable) */}
            <section className={styles.pagePreview} tabIndex={0} aria-labelledby={labelId} data-testid="pageNotesPreview">
                <MarkdownPreview markdown={notes} />
            </section>
        </div>
    );
}
