import AddIcon from '@mui/icons-material/Add';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import EditIcon from '@mui/icons-material/Edit';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import NoteAddIcon from '@mui/icons-material/NoteAdd';
import PlaylistAddCheckIcon from '@mui/icons-material/PlaylistAddCheck';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Snackbar from '@mui/material/Snackbar';
import SwipeableDrawer from '@mui/material/SwipeableDrawer';
import { useTheme } from '@mui/material/styles';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { AccountChip } from '../../components/AccountChip';
import { AccountSyncChip } from '../../components/AccountSyncChip';
import { useClaudeReview } from '../../components/claudeReview/useClaudeReview';
import type { EditableStatus } from '../../components/editItemDialogLogic';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { useItemEditor } from '../../components/itemEditor/useItemEditor';
import { ListRowShell } from '../../components/ListRowShell';
import { ListSkeleton } from '../../components/ListSkeleton';
import { batchChromeFor, ProcessInboxWizard } from '../../components/ProcessInboxWizard';
import { RoutineIndicator } from '../../components/RoutineIndicator';
import { useAppData } from '../../contexts/AppDataProvider';
import { deleteInboxCaptureDraft, getInboxCaptureDraft, saveInboxCaptureDraft } from '../../db/draftHelpers';
import { clarifyToDone, clarifyToTrash, collectItem } from '../../db/itemMutations';
import { useAutoFocus } from '../../hooks/useAutoFocus';
import { useAutosave } from '../../hooks/useAutosave';
import { useListGhosts } from '../../hooks/useListGhosts';
import { useListScrollRestoration } from '../../hooks/useListScrollRestoration';
import { useSwipeGesture } from '../../hooks/useSwipeGesture';
import { CLARIFY_MODE_KEY, parseClarifyMode } from '../../lib/clarifyMode';
import type { StoredItem } from '../../types/MyDB';
import styles from './-inbox.module.css';

dayjs.extend(relativeTime);

export const Route = createFileRoute('/_authenticated/inbox')({
    component: InboxPage,
});

// --- Mobile swipe row ---

interface InboxSwipeItemProps {
    item: StoredItem;
    // exactOptionalPropertyTypes requires explicit `| undefined` to allow passing `.find()?.title`
    routineTitle?: string | undefined;
    onTap: (item: StoredItem) => void;
    onMore: (item: StoredItem) => void;
    onSwipeNextAction: (item: StoredItem) => void;
    onSwipeTrash: (item: StoredItem) => void;
}

function InboxSwipeItem({ item, routineTitle, onTap, onMore, onSwipeNextAction, onSwipeTrash }: InboxSwipeItemProps) {
    const { touchHandlers, translateX, wasDragRef } = useSwipeGesture({
        onSwipeRight: () => onSwipeNextAction(item),
        onSwipeLeft: () => onSwipeTrash(item),
    });

    function handleClick() {
        // wasDragRef is a ref (not state), so it always holds the current value when
        // onClick fires synchronously after touchEnd — no stale-closure risk.
        if (wasDragRef.current) return;
        onTap(item);
    }
    const showRight = translateX > 0;
    const showLeft = translateX < 0;

    const { onTouchStart, onTouchMove, onTouchEnd } = touchHandlers;

    return (
        <Box className={styles.swipeWrapper}>
            {showRight && (
                <Box className={styles.revealRight}>
                    <ArrowForwardIcon fontSize="small" />
                    <Typography
                        variant="body2"
                        sx={{
                            ml: 1,
                        }}
                    >
                        Next Action
                    </Typography>
                </Box>
            )}
            {showLeft && (
                <Box className={styles.revealLeft}>
                    <Typography
                        variant="body2"
                        sx={{
                            mr: 1,
                        }}
                    >
                        Trash
                    </Typography>
                    <DeleteOutlineIcon fontSize="small" />
                </Box>
            )}
            <ListItem
                disablePadding
                className={styles.item}
                style={{
                    transform: `translateX(${translateX}px)`,
                    transition: translateX === 0 ? 'transform 0.2s ease' : 'none',
                }}
                onTouchStart={onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEnd}
                onClick={handleClick}
                secondaryAction={
                    <Tooltip title="More actions">
                        {/* onTouchEnd stops propagation so the drag handler doesn't see the tap as a swipe end */}
                        <IconButton
                            size="small"
                            onClick={(e) => {
                                e.stopPropagation();
                                onMore(item);
                            }}
                            data-testid="inboxItemMoreButton"
                        >
                            <MoreVertIcon fontSize="small" />
                        </IconButton>
                    </Tooltip>
                }
            >
                <ListItemText
                    primary={
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                            <span>{item.title}</span>
                            {item.routineId && <RoutineIndicator routineId={item.routineId} routineTitle={routineTitle} />}
                            <AccountChip userId={item.userId} />
                        </Box>
                    }
                    secondary={dayjs(item.createdTs).fromNow()}
                />
            </ListItem>
        </Box>
    );
}

// --- Mobile bottom sheet ---

interface InboxBottomSheetProps {
    item: StoredItem | null;
    onClose: () => void;
    onClarifyClaude: (item: StoredItem) => void;
    onEdit: (item: StoredItem) => void;
    onDone: (item: StoredItem) => void;
    onNextAction: (item: StoredItem) => void;
    onCalendar: (item: StoredItem) => void;
    onWaitingFor: (item: StoredItem) => void;
    onTrash: (item: StoredItem) => void;
}

function InboxBottomSheet({ item, onClose, onClarifyClaude, onEdit, onDone, onNextAction, onCalendar, onWaitingFor, onTrash }: InboxBottomSheetProps) {
    if (!item) return null;

    const resolvedItem = item;

    function action(fn: (i: StoredItem) => void) {
        fn(resolvedItem);
        onClose();
    }

    return (
        <SwipeableDrawer anchor="bottom" open={Boolean(item)} onClose={onClose} onOpen={() => {}}>
            <Box className={styles.sheetHandle} />
            <Typography
                variant="subtitle1"
                sx={{
                    fontWeight: 600,
                    px: 2,
                    pb: 1,
                }}
            >
                {item.title}
            </Typography>
            <Divider />
            <List disablePadding>
                <ListItemButton onClick={() => action(onClarifyClaude)} data-testid="inboxSheetClarifyClaude">
                    <ListItemIcon>
                        <AutoAwesomeIcon color="primary" />
                    </ListItemIcon>
                    <ListItemText primary="Clarify with Claude" />
                </ListItemButton>
                <ListItemButton onClick={() => action(onEdit)}>
                    <ListItemIcon>
                        <EditIcon />
                    </ListItemIcon>
                    <ListItemText primary="Edit" />
                </ListItemButton>
                <ListItemButton onClick={() => action(onDone)}>
                    <ListItemIcon>
                        <PlaylistAddCheckIcon />
                    </ListItemIcon>
                    <ListItemText primary="Done (< 2 min)" />
                </ListItemButton>
                <ListItemButton onClick={() => action(onNextAction)}>
                    <ListItemIcon>
                        <ArrowForwardIcon />
                    </ListItemIcon>
                    <ListItemText primary="Next Action" />
                </ListItemButton>
                <ListItemButton onClick={() => action(onCalendar)}>
                    <ListItemIcon>
                        <CalendarTodayIcon />
                    </ListItemIcon>
                    <ListItemText primary="Calendar" />
                </ListItemButton>
                <ListItemButton onClick={() => action(onWaitingFor)}>
                    <ListItemIcon>
                        <HourglassEmptyIcon />
                    </ListItemIcon>
                    <ListItemText primary="Waiting For" />
                </ListItemButton>
                <ListItemButton onClick={() => action(onTrash)}>
                    <ListItemIcon>
                        <DeleteOutlineIcon color="error" />
                    </ListItemIcon>
                    <ListItemText primary="Trash" slotProps={{ primary: { color: 'error' } }} />
                </ListItemButton>
            </List>
            <Box
                sx={{
                    pb: 2,
                }}
            />
        </SwipeableDrawer>
    );
}

// --- Page ---

function InboxPage() {
    const { db } = Route.useRouteContext();
    const { account, items, workContexts, people, routines, refreshItems, syncAndRefresh, isInitialSyncing, withOwnerSession } = useAppData();
    const navigate = useNavigate();
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
    const captureFieldRef = useAutoFocus();

    // Inbox is the only page where 'instant' fires the no-fields nextAction shortcut.
    const editor = useItemEditor({ db, people, workContexts, refreshItems, allowInstantNextAction: true, isMobile });

    // Claude "Clarify" review sheet. onApplied pulls from the server (not just refreshItems): the
    // apply endpoint writes through the op-log server-side, so the change comes back via a sync pull.
    const review = useClaudeReview({ people, workContexts, onApplied: syncAndRefresh, withOwnerSession });

    const [draft, setDraft] = useState('');
    const [notes, setNotes] = useState('');
    const [notesOpen, setNotesOpen] = useState(false);
    const [notesTab, setNotesTab] = useState<0 | 1>(0);

    // Capture-field draft persistence: half-typed title/notes survive reloads and navigation.
    // Debounce is short — writes are local-only (drafts never sync), so eager persistence is cheap.
    const draftAutosave = useAutosave<{ title: string; notes: string }>({
        initial: { title: '', notes: '' },
        delayMs: 300,
        commit: async (value) => {
            if (account) {
                await saveInboxCaptureDraft(db, account.id, value);
            }
        },
    });

    // Restore a persisted draft once on mount. isDirty() means the user already started typing
    // before the IDB read resolved — their live input wins over the stored leftover.
    useEffect(() => {
        if (!account) {
            return;
        }
        let cancelled = false;
        void getInboxCaptureDraft(db, account.id).then((stored) => {
            if (cancelled || !stored || draftAutosave.isDirty()) {
                return;
            }
            setDraft(stored.title);
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
    }, [account, db, draftAutosave]);

    function onCaptureFieldsChange(nextTitle: string, nextNotes: string) {
        setDraft(nextTitle);
        setNotes(nextNotes);
        draftAutosave.onChange({ title: nextTitle, notes: nextNotes });
    }

    // Batch "Process Inbox" wizard — same ItemEditorBody as single-item editing, just sequenced.
    // Snapshot the items at the moment "Process Inbox" is clicked so saves that move items out
    // of the inbox don't shrink the array mid-walk and skew the wizard's index. Trade-off: if
    // another device updates the same item mid-wizard, the wizard edits the stale snapshot row
    // and a save would clobber the remote update (last-write-wins). Acceptable — the alternative
    // (live array) drops items from under the index and is strictly worse.
    const [batchSnapshot, setBatchSnapshot] = useState<StoredItem[] | null>(null);

    // Mobile bottom sheet — reachable via the per-row "more" button. Tap on the row body now
    // opens the unified editor instead.
    const [bottomSheetItem, setBottomSheetItem] = useState<StoredItem | null>(null);

    useListScrollRestoration();
    const { itemsWithGhosts, isGhost, onGhostExited } = useListGhosts(items);

    const inboxItems = itemsWithGhosts.filter((item) => item.status === 'inbox').sort((a, b) => b.createdTs.localeCompare(a.createdTs));

    // Ghosts are fading leftovers of items just clarified away — counts and the batch wizard use live rows only.
    const liveInboxItems = inboxItems.filter((item) => !isGhost(item));

    async function onCapture() {
        const title = draft.trim();
        if (!title || !account) {
            return;
        }
        setDraft('');
        setNotes('');
        setNotesOpen(false);
        setNotesTab(0);
        // The text is committed as a real item — drop the draft row and re-baseline the autosave
        // so a pending debounce tick can't resurrect the just-captured text. reset() drops the
        // scheduled timer; flush() then drains any commit already in flight before the delete.
        draftAutosave.reset({ title: '', notes: '' });
        await draftAutosave.flush();
        await deleteInboxCaptureDraft(db, account.id);
        await collectItem(db, account.id, { title, notes });
        await refreshItems();
    }

    async function onKeyDown(e: React.KeyboardEvent) {
        if (e.key === 'Enter') await onCapture();
    }

    async function onQuickDone(item: StoredItem) {
        await clarifyToDone(db, item, { onReadOnlyGCal: editor.onFromGmailReadOnly });
        await refreshItems();
    }

    async function onTrash(item: StoredItem) {
        await clarifyToTrash(db, item);
        await refreshItems();
    }

    function openWithStatus(item: StoredItem, status: EditableStatus, anchor?: HTMLElement) {
        editor.openEditor({ item, initialStatus: status, ...(anchor ? { anchor } : {}) });
    }

    function startProcessInbox() {
        if (liveInboxItems.length === 0) {
            return;
        }
        // page mode is the only chrome that needs route navigation; every other setting flows
        // into the in-place dialog wizard (popover/expand/instant don't make sense for batch).
        const chrome = batchChromeFor(parseClarifyMode(localStorage.getItem(CLARIFY_MODE_KEY)));
        if (chrome === 'page') {
            void navigate({ to: '/process-inbox' });
            return;
        }
        setBatchSnapshot(liveInboxItems);
    }

    return (
        <Box>
            <Box className={styles.pageHeader}>
                {/* Title + sync chip grouped so the chip stays beside the title; pageHeader's space-between keeps the button right. */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography
                        variant="h5"
                        sx={{
                            fontWeight: 600,
                        }}
                    >
                        Inbox
                        {liveInboxItems.length > 0 && <Chip label={liveInboxItems.length} size="small" color="primary" className={styles.countChip} />}
                    </Typography>
                    <AccountSyncChip />
                </Box>
                <Button variant="outlined" size="small" disabled={liveInboxItems.length === 0} onClick={startProcessInbox} data-testid="processInboxButton">
                    Process Inbox ({liveInboxItems.length})
                </Button>
            </Box>
            <Paper variant="outlined" className={styles.captureCard}>
                <TextField
                    fullWidth
                    placeholder="What's on your mind?"
                    value={draft}
                    onChange={(e) => onCaptureFieldsChange(e.target.value, notes)}
                    onKeyDown={onKeyDown}
                    slotProps={{
                        htmlInput: { ref: captureFieldRef },
                        input: {
                            endAdornment: (
                                <InputAdornment position="end">
                                    <Tooltip title={notesOpen ? 'Hide note' : 'Add note'}>
                                        {/* color="primary" when notes have content so user knows a note is attached */}
                                        <IconButton
                                            onClick={() => setNotesOpen((o) => !o)}
                                            color={notes.trim() ? 'primary' : 'default'}
                                            data-testid="inboxAddNoteButton"
                                        >
                                            <NoteAddIcon />
                                        </IconButton>
                                    </Tooltip>
                                    <IconButton onClick={onCapture} disabled={!draft.trim()} edge="end">
                                        <AddIcon />
                                    </IconButton>
                                </InputAdornment>
                            ),
                        },
                    }}
                    className={styles.captureField}
                />
                {notesOpen && (
                    <Box className={styles.captureNotes}>
                        <Tabs value={notesTab} onChange={(_, v) => setNotesTab(v as 0 | 1)} className={styles.tabs}>
                            <Tab label="Edit" value={0} />
                            <Tab label="Preview" value={1} />
                        </Tabs>
                        {notesTab === 0 ? (
                            <TextField
                                label="Notes (Markdown)"
                                value={notes}
                                onChange={(e) => onCaptureFieldsChange(draft, e.target.value)}
                                fullWidth
                                multiline
                                rows={5}
                                placeholder="Supports **bold**, _italic_, `code`, lists, etc."
                            />
                        ) : (
                            <div className={styles.notesPreview}>
                                {notes.trim() ? <ReactMarkdown>{notes}</ReactMarkdown> : <span className={styles.notesEmpty}>Nothing to preview.</span>}
                            </div>
                        )}
                    </Box>
                )}
            </Paper>
            {inboxItems.length === 0 ? (
                // Skeleton during first-launch bootstrap; the "inbox zero" copy is only truthful once loaded.
                isInitialSyncing ? (
                    <ListSkeleton />
                ) : (
                    <Typography
                        sx={{
                            color: 'text.secondary',
                            textAlign: 'center',
                            mt: 6,
                        }}
                    >
                        Inbox zero — well done.
                    </Typography>
                )
            ) : (
                <List disablePadding className={styles.list}>
                    {inboxItems.map((item, idx) => (
                        <ListRowShell key={item._id} itemId={item._id} isGhost={isGhost(item)} onGhostExited={onGhostExited}>
                            {isMobile ? (
                                <InboxSwipeItem
                                    item={item}
                                    routineTitle={routines.find((r) => r._id === item.routineId)?.title}
                                    onTap={(i) => editor.openEditor({ item: i })}
                                    onMore={setBottomSheetItem}
                                    onSwipeNextAction={(i) => editor.openEditor({ item: i, initialStatus: 'nextAction' })}
                                    onSwipeTrash={(i) => void onTrash(i)}
                                />
                            ) : (
                                <ListItem
                                    disablePadding
                                    className={styles.item}
                                    secondaryAction={
                                        <Box className={styles.actionButtons}>
                                            <CopyIdButton id={item._id} testId="inboxItemCopyIdButton" />
                                            <Tooltip title="Clarify with Claude">
                                                <IconButton
                                                    size="small"
                                                    color="primary"
                                                    onClick={() => review.openFor(item)}
                                                    data-testid="inboxItemClarifyClaudeButton"
                                                >
                                                    <AutoAwesomeIcon fontSize="small" />
                                                </IconButton>
                                            </Tooltip>
                                            <Tooltip title="Edit">
                                                <IconButton size="small" onClick={() => editor.openEditor({ item })} data-testid="inboxItemEditButton">
                                                    <EditIcon fontSize="small" />
                                                </IconButton>
                                            </Tooltip>
                                            <Tooltip title="Done (< 2 min)">
                                                <IconButton size="small" onClick={() => void onQuickDone(item)}>
                                                    <PlaylistAddCheckIcon fontSize="small" />
                                                </IconButton>
                                            </Tooltip>
                                            <Tooltip title="Next Action">
                                                <IconButton size="small" onClick={(e) => openWithStatus(item, 'nextAction', e.currentTarget)}>
                                                    <ArrowForwardIcon fontSize="small" />
                                                </IconButton>
                                            </Tooltip>
                                            <Tooltip title="Calendar">
                                                <IconButton size="small" onClick={(e) => openWithStatus(item, 'calendar', e.currentTarget)}>
                                                    <CalendarTodayIcon fontSize="small" />
                                                </IconButton>
                                            </Tooltip>
                                            <Tooltip title="Waiting For">
                                                <IconButton size="small" onClick={(e) => openWithStatus(item, 'waitingFor', e.currentTarget)}>
                                                    <HourglassEmptyIcon fontSize="small" />
                                                </IconButton>
                                            </Tooltip>
                                            <Tooltip title="Trash">
                                                <IconButton size="small" color="error" onClick={() => void onTrash(item)}>
                                                    <DeleteOutlineIcon fontSize="small" />
                                                </IconButton>
                                            </Tooltip>
                                        </Box>
                                    }
                                >
                                    <ListItemButton onClick={() => editor.openEditor({ item })} data-testid="inboxItemRow">
                                        <ListItemText
                                            primary={
                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                                    <span>{item.title}</span>
                                                    {item.routineId && (
                                                        <RoutineIndicator
                                                            routineId={item.routineId}
                                                            routineTitle={routines.find((r) => r._id === item.routineId)?.title}
                                                        />
                                                    )}
                                                    <AccountChip userId={item.userId} />
                                                </Box>
                                            }
                                            secondary={dayjs(item.createdTs).fromNow()}
                                            className={styles.listItemText}
                                        />
                                    </ListItemButton>
                                </ListItem>
                            )}

                            {editor.renderExpandFor(item._id)}

                            {idx < inboxItems.length - 1 && <Divider />}
                        </ListRowShell>
                    ))}
                </List>
            )}

            {editor.renderGlobal()}
            {review.renderGlobal()}
            <Snackbar open={editor.instantToast.open} autoHideDuration={3000} onClose={editor.closeInstantToast} message={editor.instantToast.message} />

            {batchSnapshot && (
                <ProcessInboxWizard
                    items={batchSnapshot}
                    db={db}
                    people={people}
                    workContexts={workContexts}
                    onClose={() => setBatchSnapshot(null)}
                    onItemProcessed={refreshItems}
                />
            )}

            <InboxBottomSheet
                item={bottomSheetItem}
                onClose={() => setBottomSheetItem(null)}
                onClarifyClaude={(i) => review.openFor(i)}
                onEdit={(i) => editor.openEditor({ item: i })}
                onDone={(i) => void onQuickDone(i)}
                onNextAction={(i) => editor.openEditor({ item: i, initialStatus: 'nextAction' })}
                onCalendar={(i) => editor.openEditor({ item: i, initialStatus: 'calendar' })}
                onWaitingFor={(i) => editor.openEditor({ item: i, initialStatus: 'waitingFor' })}
                onTrash={(i) => void onTrash(i)}
            />
        </Box>
    );
}
