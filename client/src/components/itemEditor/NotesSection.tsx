import CheckIcon from '@mui/icons-material/Check';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import { useEffect, useId, useRef, useState } from 'react';
import { type ItemEditorChrome, notesAreEmpty } from '../editItemDialogLogic';
import { MarkdownNotesEditor, NOTES_EDITOR_LABEL, NOTES_PLACEHOLDER } from '../markdown/MarkdownNotesEditor';
import { MarkdownPreview } from '../markdown/MarkdownPreview';
import styles from './ItemEditorBody.module.css';

interface NotesSectionProps {
    notes: string;
    onNotesChange: (next: string) => void;
    chrome: ItemEditorChrome;
    /**
     * Review presentation with a brief on show: the notes start folded behind a "Show notes"
     * disclosure (the brief already says what the item is) and expand in place on demand.
     */
    collapsible?: boolean;
}

/**
 * Notes editor section. Two surface variants:
 * - Page mode: defaults to a read-only Markdown preview when notes exist; only the pencil button
 *   switches to a focused CodeMirror editor (edits autosave through `onNotesChange`). The "Done"
 *   button, Escape, or moving focus elsewhere return to the preview while notes are non-empty.
 *   Empty notes start in the editor so the affordance is obvious.
 * - All other chromes (dialog/popover/expand): tabbed Edit/Preview, unchanged from the previous
 *   behaviour. The page-mode redesign was scoped intentionally — the smaller surfaces are short
 *   and edit-oriented and don't need the read-mostly default.
 */
export function NotesSection({ notes, onNotesChange, chrome, collapsible = false }: NotesSectionProps) {
    // Hook first, then the disclosure guard: the early return below must not change hook order.
    const [isExpanded, setIsExpanded] = useState(false);
    if (collapsible && !isExpanded) {
        return (
            <Box>
                <Button size="small" color="inherit" startIcon={<ExpandMoreIcon />} onClick={() => setIsExpanded(true)} data-testid="showNotesButton">
                    Show notes
                </Button>
            </Box>
        );
    }
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
    const enterEdit = () => {
        focusOnNextEditMount.current = true;
        setEditing(true);
    };
    // Empty notes have nothing to preview — the editor stays the resting state.
    const exitEditIfNotesExist = () => {
        if (notesAreEmpty(notesRef.current)) {
            return false;
        }
        setEditing(false);
        return true;
    };
    const exitEditExplicitly = () => {
        const didExit = exitEditIfNotesExist();
        focusEditButtonOnPreviewMount.current = didExit;
        return didExit;
    };

    if (editing) {
        // autoFocus prop is captured at mount; reset the flag synchronously after read so the next
        // `editing` cycle (e.g. after blur→preview→pencil again) decides for itself.
        const shouldFocus = focusOnNextEditMount.current;
        focusOnNextEditMount.current = false;
        return (
            <Box>
                <Box className={styles.notesHeader}>
                    <Typography variant="caption" id={labelId} className={styles.sectionLabel} sx={{ color: 'text.secondary', fontWeight: 600, mb: 0 }}>
                        {NOTES_EDITOR_LABEL}
                    </Typography>
                    {/* Always rendered (disabled while empty) so the header doesn't jump when the
                        first character is typed. */}
                    <IconButton
                        size="small"
                        aria-label="Done editing notes"
                        title="Done editing notes"
                        disabled={notesAreEmpty(notes)}
                        // Keep focus in the editor on press: otherwise its blur flips to preview
                        // first and the click would land on nothing (or re-enter edit).
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={exitEditExplicitly}
                    >
                        <CheckIcon fontSize="small" />
                    </IconButton>
                </Box>
                <MarkdownNotesEditor
                    value={notes}
                    onValueChange={onNotesChange}
                    placeholder={NOTES_PLACEHOLDER}
                    autoFocus={shouldFocus}
                    onBlurOutside={exitEditIfNotesExist}
                    // First ESC steps out to the preview; claiming the key (return true) makes
                    // CodeMirror preventDefault so the page-level ESC listener doesn't also navigate
                    // back. With empty notes the editor is the resting state — ESC falls through.
                    onEscape={exitEditExplicitly}
                />
            </Box>
        );
    }

    // The preview is read-only: selecting text and following links must never flip it into the
    // editor — the pencil is the only way in. It stays focusable so keyboard users can scroll
    // long notes inside the capped-height region.
    return (
        <Box>
            <Box className={styles.notesHeader}>
                <Typography variant="caption" id={labelId} className={styles.sectionLabel} sx={{ color: 'text.secondary', fontWeight: 600, mb: 0 }}>
                    {NOTES_EDITOR_LABEL}
                </Typography>
                <IconButton ref={editButtonRef} size="small" aria-label="Edit notes" title="Edit notes" onClick={enterEdit}>
                    <EditOutlinedIcon fontSize="small" />
                </IconButton>
            </Box>
            <Box className={styles.pagePreview} tabIndex={0} role="region" aria-labelledby={labelId} data-testid="pageNotesPreview">
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
