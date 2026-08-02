import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import { useId, useRef, useState } from 'react';
import { type ItemEditorChrome, notesAreEmpty } from '../editItemDialogLogic';
import { MarkdownNotesEditor, NOTES_EDITOR_LABEL, NOTES_PLACEHOLDER } from '../markdown/MarkdownNotesEditor';
import { MarkdownPreview } from '../markdown/MarkdownPreview';
import styles from './ItemEditorBody.module.css';

interface NotesSectionProps {
    notes: string;
    onNotesChange: (next: string) => void;
    chrome: ItemEditorChrome;
}

/**
 * Notes editor section. Two surface variants:
 * - Page mode: click-to-edit. Defaults to a Markdown preview when notes exist; clicking the
 *   preview switches to a focused CodeMirror editor; blurring with non-empty notes returns to
 *   preview. Empty notes start in the editor so the affordance is obvious.
 * - All other chromes (dialog/popover/expand): tabbed Edit/Preview, unchanged from the previous
 *   behaviour. The page-mode redesign was scoped intentionally — the smaller surfaces are short
 *   and edit-oriented and don't need the read-mostly default.
 */
export function NotesSection({ notes, onNotesChange, chrome }: NotesSectionProps) {
    if (chrome === 'page') {
        return <PageNotesSection notes={notes} onNotesChange={onNotesChange} />;
    }
    return <TabbedNotesSection notes={notes} onNotesChange={onNotesChange} />;
}

function PageNotesSection({ notes, onNotesChange }: { notes: string; onNotesChange: (n: string) => void }) {
    // Empty notes start in the editor so the user sees a clear writing surface; non-empty notes
    // start in preview so the page reads like a document.
    const [editing, setEditing] = useState(() => notesAreEmpty(notes));
    // Auto-focus must only fire on the user's preview→edit transition, not the initial mount.
    // Otherwise a freshly opened item with empty notes would yank focus to the editor — the
    // exact pattern we removed from the title input. The flag persists across re-renders via ref.
    const focusOnNextEditMount = useRef(false);
    // Per-instance id for the section label's aria-labelledby — useId guarantees uniqueness if
    // the section ever renders more than once in a tree (split pane, side-by-side comparison).
    const labelId = useId();
    // The editor's Escape/blur callbacks read notes through a ref so they always see the latest
    // value even though CodeMirror captures them once at mount.
    const notesRef = useRef(notes);
    notesRef.current = notes;
    const enterEdit = () => {
        focusOnNextEditMount.current = true;
        setEditing(true);
    };

    if (editing) {
        // autoFocus prop is captured at mount; reset the flag synchronously after read so the next
        // `editing` cycle (e.g. after blur→preview→click again) decides for itself.
        const shouldFocus = focusOnNextEditMount.current;
        focusOnNextEditMount.current = false;
        return (
            <Box>
                <Typography variant="caption" id={labelId} className={styles.sectionLabel} sx={{ color: 'text.secondary', fontWeight: 600 }}>
                    {NOTES_EDITOR_LABEL}
                </Typography>
                <MarkdownNotesEditor
                    value={notes}
                    onValueChange={onNotesChange}
                    placeholder={NOTES_PLACEHOLDER}
                    autoFocus={shouldFocus}
                    onBlurOutside={() => {
                        // Stay in editor when notes are still empty — the user can keep typing.
                        if (!notesAreEmpty(notesRef.current)) {
                            setEditing(false);
                        }
                    }}
                    onEscape={() => {
                        // First ESC steps out to the preview; claiming the key (return true) makes
                        // CodeMirror preventDefault so the page-level ESC listener doesn't also
                        // navigate back. With empty notes the editor is the resting state — let
                        // ESC fall through.
                        if (notesAreEmpty(notesRef.current)) {
                            return false;
                        }
                        setEditing(false);
                        return true;
                    }}
                />
            </Box>
        );
    }

    return (
        <Box>
            <Box className={styles.notesHeader}>
                <Typography variant="caption" id={labelId} className={styles.sectionLabel} sx={{ color: 'text.secondary', fontWeight: 600, mb: 0 }}>
                    {NOTES_EDITOR_LABEL}
                </Typography>
                <IconButton size="small" aria-label="Edit notes" onClick={enterEdit}>
                    <EditOutlinedIcon fontSize="small" />
                </IconButton>
            </Box>
            <Box
                className={styles.previewClickable}
                tabIndex={0}
                role="region"
                aria-labelledby={labelId}
                data-testid="pageNotesPreview"
                onClick={enterEdit}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        enterEdit();
                    }
                }}
            >
                <MarkdownPreview markdown={notes} />
            </Box>
        </Box>
    );
}

function TabbedNotesSection({ notes, onNotesChange }: { notes: string; onNotesChange: (n: string) => void }) {
    const [tab, setTab] = useState<0 | 1>(0);
    return (
        <Box>
            <Tabs value={tab} onChange={(_, v) => setTab(v as 0 | 1)} className={styles.tabs}>
                <Tab label="Edit" value={0} />
                <Tab label="Preview" value={1} />
            </Tabs>
            {tab === 0 ? (
                <MarkdownNotesEditor value={notes} onValueChange={onNotesChange} placeholder={NOTES_PLACEHOLDER} />
            ) : (
                <Box className={styles.preview}>
                    {notes.trim() ? <MarkdownPreview markdown={notes} /> : <span className={styles.empty}>Nothing to preview.</span>}
                </Box>
            )}
        </Box>
    );
}
