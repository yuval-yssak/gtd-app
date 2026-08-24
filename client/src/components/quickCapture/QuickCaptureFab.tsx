import AddIcon from '@mui/icons-material/Add';
import NoteAddIcon from '@mui/icons-material/NoteAdd';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Fab from '@mui/material/Fab';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import type { IDBPDatabase } from 'idb';
import { useEffect, useRef, useState } from 'react';
import { useAppData } from '../../contexts/AppDataProvider';
import { deleteQuickCaptureDraft, getQuickCaptureDraft, saveQuickCaptureDraft } from '../../db/draftHelpers';
import { collectItem } from '../../db/itemMutations';
import { useAutosave } from '../../hooks/useAutosave';
import { useHiddenAccountCaptureNotice } from '../../hooks/useHiddenAccountCaptureNotice';
import type { MyDB } from '../../types/MyDB';
import { MarkdownNotesEditor, NOTES_PLACEHOLDER } from '../markdown/MarkdownNotesEditor';
import { MarkdownPreview } from '../markdown/MarkdownPreview';
import styles from './QuickCaptureFab.module.css';
import { isEditableEventTarget, shouldOpenQuickCapture } from './quickCaptureLogic';

/**
 * App-wide "add to inbox" affordance: a floating action button on every authenticated page plus
 * the "c" keyboard shortcut. The dialog stays open after each capture so a brain-dump of several
 * thoughts needs no re-opening; Escape or Done closes it. Typed-but-uncaptured text persists as a
 * device-local draft (its own kind, separate from the inbox page's field) and restores on reopen.
 */
export function QuickCaptureFab({ db }: { db: IDBPDatabase<MyDB> }) {
    const { account, refreshItems } = useAppData();
    const [isOpen, setIsOpen] = useState(false);
    const [title, setTitle] = useState('');
    const [notes, setNotes] = useState('');
    const [notesOpen, setNotesOpen] = useState(false);
    const [notesTab, setNotesTab] = useState<0 | 1>(0);
    const [capturedCount, setCapturedCount] = useState(0);
    const { noticeCaptureIfHidden, hiddenAccountNotice } = useHiddenAccountCaptureNotice();
    // Dedupes Enter + button double-submits within one React batch — transitions don't dedupe,
    // so per the client conventions a ref guards the in-flight window.
    const captureInFlightRef = useRef(false);

    // Draft persistence — same debounce/commit shape as the inbox capture field.
    const draftAutosave = useAutosave<{ title: string; notes: string }>({
        initial: { title: '', notes: '' },
        delayMs: 300,
        commit: async (value) => {
            if (account) {
                await saveQuickCaptureDraft(db, account.id, value);
            }
        },
    });

    // Restore leftover text each time the dialog opens. isDirty() means the user already started
    // typing before the IDB read resolved — their live input wins over the stored leftover.
    useEffect(() => {
        if (!isOpen || !account) {
            return;
        }
        let cancelled = false;
        void getQuickCaptureDraft(db, account.id).then((stored) => {
            if (cancelled || !stored || draftAutosave.isDirty()) {
                return;
            }
            setTitle(stored.title);
            setNotes(stored.notes);
            if (stored.notes) {
                setNotesOpen(true);
            }
            // Re-baseline so restoring doesn't immediately rewrite the same draft row.
            draftAutosave.reset({ title: stored.title, notes: stored.notes });
        });
        return () => {
            cancelled = true;
        };
        // draftAutosave is a stable controller instance; account/db are boot-stable.
    }, [isOpen, account, db, draftAutosave]);

    // Ref-routed listener (same shape as usePageEscapeToClose) — attaches once, reads fresh state.
    const openDialogRef = useRef(() => {});
    openDialogRef.current = () => setIsOpen(true);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            // :not([aria-hidden]) — keep-mounted modals (AppNav's mobile drawer) sit in the DOM
            // permanently; MUI marks them aria-hidden while closed, so bare presence ≠ open.
            const isModalOpen = document.querySelector('.MuiModal-root:not([aria-hidden="true"])') !== null;
            if (shouldOpenQuickCapture(event, { isModalOpen, isEditableTarget: isEditableEventTarget(event.target) })) {
                event.preventDefault();
                openDialogRef.current();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, []);

    function onFieldsChange(nextTitle: string, nextNotes: string) {
        setTitle(nextTitle);
        setNotes(nextNotes);
        draftAutosave.onChange({ title: nextTitle, notes: nextNotes });
    }

    async function onCapture() {
        const trimmed = title.trim();
        if (!trimmed || !account || captureInFlightRef.current) {
            return;
        }
        captureInFlightRef.current = true;
        try {
            setTitle('');
            setNotes('');
            setNotesOpen(false);
            setNotesTab(0);
            // The text is committed as a real item — drop the draft row and re-baseline the
            // autosave so a pending debounce tick can't resurrect the just-captured text.
            draftAutosave.reset({ title: '', notes: '' });
            await draftAutosave.flush();
            await deleteQuickCaptureDraft(db, account.id);
            await collectItem(db, account.id, { title: trimmed, notes });
            await refreshItems();
            setCapturedCount((count) => count + 1);
            noticeCaptureIfHidden(account.id);
        } finally {
            captureInFlightRef.current = false;
        }
    }

    // Uncaptured text deliberately survives the close — the draft restores it on reopen.
    function onClose() {
        setIsOpen(false);
        setCapturedCount(0);
    }

    return (
        <>
            <Tooltip title="Add to inbox (c)">
                <Fab color="primary" aria-label="add to inbox" className={styles.fab} onClick={() => setIsOpen(true)} data-testid="quickCaptureFab">
                    <AddIcon />
                </Fab>
            </Tooltip>

            <Dialog open={isOpen} onClose={onClose} fullWidth maxWidth="sm" data-testid="quickCaptureDialog">
                <DialogTitle>Add to inbox</DialogTitle>
                <DialogContent>
                    <TextField
                        // MUI autoFocus works here: the Dialog mounts the field fresh on each open.
                        autoFocus
                        fullWidth
                        variant="standard"
                        placeholder="What's on your mind?"
                        value={title}
                        onChange={(e) => onFieldsChange(e.target.value, notes)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') void onCapture();
                        }}
                        slotProps={{
                            htmlInput: { 'data-testid': 'quickCaptureInput' },
                            input: {
                                endAdornment: (
                                    <InputAdornment position="end">
                                        <Tooltip title={notesOpen ? 'Hide note' : 'Add note'}>
                                            {/* color="primary" when notes have content so the user knows a note is attached */}
                                            <IconButton
                                                onClick={() => setNotesOpen((open) => !open)}
                                                color={notes.trim() ? 'primary' : 'default'}
                                                data-testid="quickCaptureAddNoteButton"
                                            >
                                                <NoteAddIcon />
                                            </IconButton>
                                        </Tooltip>
                                    </InputAdornment>
                                ),
                            },
                        }}
                    />
                    {notesOpen && (
                        <Box className={styles.captureNotes} data-testid="quickCaptureNotes">
                            <Tabs value={notesTab} onChange={(_, tab) => setNotesTab(tab as 0 | 1)} className={styles.tabs}>
                                <Tab label="Edit" value={0} />
                                <Tab label="Preview" value={1} />
                            </Tabs>
                            {notesTab === 0 ? (
                                <MarkdownNotesEditor value={notes} onValueChange={(next) => onFieldsChange(title, next)} placeholder={NOTES_PLACEHOLDER} />
                            ) : (
                                <div className={styles.notesPreview}>
                                    {notes.trim() ? <MarkdownPreview markdown={notes} /> : <span className={styles.notesEmpty}>Nothing to preview.</span>}
                                </div>
                            )}
                        </Box>
                    )}
                </DialogContent>
                <DialogActions>
                    {capturedCount > 0 && (
                        <Chip
                            size="small"
                            color="success"
                            variant="outlined"
                            className={styles.capturedCount}
                            label={`${capturedCount} captured`}
                            data-testid="quickCaptureCount"
                        />
                    )}
                    <Button onClick={onClose} data-testid="quickCaptureClose">
                        Done
                    </Button>
                    <Button variant="contained" onClick={() => void onCapture()} disabled={!title.trim()} data-testid="quickCaptureSubmit">
                        Capture
                    </Button>
                </DialogActions>
            </Dialog>

            {hiddenAccountNotice}
        </>
    );
}
