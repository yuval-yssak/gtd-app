import AddIcon from '@mui/icons-material/Add';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { WindowVirtualizer } from 'virtua';
import { AccountChip } from '../../components/AccountChip';
import { AccountSyncChip } from '../../components/AccountSyncChip';
import type { EditableStatus } from '../../components/editItemDialogLogic';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { useItemEditor } from '../../components/itemEditor/useItemEditor';
import { ListRowShell } from '../../components/ListRowShell';
import { ListSearchButton, ListSearchField } from '../../components/ListSearch';
import { ListSkeleton } from '../../components/ListSkeleton';
import { MarkdownNotesEditor, NOTES_PLACEHOLDER } from '../../components/markdown/MarkdownNotesEditor';
import { MarkdownPreview } from '../../components/markdown/MarkdownPreview';
import { batchChromeFor, ProcessInboxWizard } from '../../components/ProcessInboxWizard';
import { RoutineIndicator } from '../../components/RoutineIndicator';
import { RowActionButton } from '../../components/RowActionButton';
import { RankedListChrome } from '../../components/rankedList/RankedListChrome';
import { RankedRowHandle } from '../../components/rankedList/RankedRowHandle';
import { type ItemRow, rankedRowButtonProps, rankedRowProps } from '../../components/rankedList/rankedRowProps';
import { useAppData } from '../../contexts/AppDataProvider';
import { deleteInboxCaptureDraft, getInboxCaptureDraft, saveInboxCaptureDraft } from '../../db/draftHelpers';
import { clarifyToDone, clarifyToTrash, collectItem } from '../../db/itemMutations';
import { useAutoFocus } from '../../hooks/useAutoFocus';
import { useAutosave } from '../../hooks/useAutosave';
import { useCaptureNotesPanel } from '../../hooks/useCaptureNotesPanel';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useHiddenAccountCaptureNotice } from '../../hooks/useHiddenAccountCaptureNotice';
import { useListGhosts } from '../../hooks/useListGhosts';
import { useListScrollRestoration } from '../../hooks/useListScrollRestoration';
import { useListSearch } from '../../hooks/useListSearch';
import { type RankedListApi, useRankedList } from '../../hooks/useRankedList';
import { useSwipeGesture } from '../../hooks/useSwipeGesture';
import { CLARIFY_MODE_KEY, parseClarifyMode } from '../../lib/clarifyMode';
import { compareByRank } from '../../lib/compareNextActions';
import { filterItemsByQuery } from '../../lib/itemSearch';
import { parseListQuerySearch } from '../../lib/listQueryUrlParams';
import { flatSection, itemRows } from '../../lib/nextActionSections';
import { ownerIdsOfStatus } from '../../lib/rankSections';
import { RANKED_LIST_ROW_ACTIONS } from '../../lib/rowShortcuts';
import type { StoredItem } from '../../types/MyDB';
import styles from './-inbox.module.css';

dayjs.extend(relativeTime);

export const Route = createFileRoute('/_authenticated/inbox')({
    validateSearch: parseListQuerySearch,
    component: InboxPage,
});

// --- Mobile swipe row ---

const stopPropagation = (e: { stopPropagation: () => void }) => e.stopPropagation();
/** The reorder handle's whole touch gesture (and its tap) stays its own: none of it may reach the row's swipe or tap. */
const KEEP_GESTURE_TO_HANDLE = {
    onTouchStart: stopPropagation,
    onTouchMove: stopPropagation,
    onTouchEnd: stopPropagation,
    onTouchCancel: stopPropagation,
    onClick: stopPropagation,
};

interface InboxSwipeItemProps {
    item: StoredItem;
    // exactOptionalPropertyTypes requires explicit `| undefined` to allow passing `.find()?.title`
    routineTitle?: string | undefined;
    onTap: (item: StoredItem) => void;
    onMore: (item: StoredItem) => void;
    onSwipeNextAction: (item: StoredItem) => void;
    onSwipeTrash: (item: StoredItem) => void;
    /** Long-press drag reorder: the shared ranked-list wiring and this row's place in it. */
    ranked: RankedListApi;
    row: ItemRow;
    isGhost: boolean;
}

function InboxSwipeItem({ item, routineTitle, onTap, onMore, onSwipeNextAction, onSwipeTrash, ranked, row, isGhost }: InboxSwipeItemProps) {
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

    const { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel } = touchHandlers;

    return (
        // The ranked-row props go on the wrapper: the drag moves and shifts the whole row (reveal panes included).
        <Box {...rankedRowProps(ranked, row, styles.swipeWrapper)}>
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
                className={styles.swipeItem}
                style={{
                    transform: `translateX(${translateX}px)`,
                    transition: translateX === 0 ? 'transform 0.2s ease' : 'none',
                }}
                onTouchStart={onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEnd}
                onTouchCancel={onTouchCancel}
                onClick={handleClick}
                secondaryAction={
                    <Tooltip title="More actions">
                        {/* onClick stops propagation so the More tap never also opens the editor (the row's own onClick). */}
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
                {/* Long press drags (as on every ranked list). Its touches must not also start the row's
                    horizontal swipe, nor its tap open the editor. A ghost is not a drag source. */}
                {!isGhost && (
                    <Box className={styles.swipeHandle} {...KEEP_GESTURE_TO_HANDLE}>
                        <RankedRowHandle ranked={ranked} item={item} section={row.section} testId="inboxDragHandle" />
                    </Box>
                )}
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
    onEdit: (item: StoredItem) => void;
    onDone: (item: StoredItem) => void;
    onNextAction: (item: StoredItem) => void;
    onCalendar: (item: StoredItem) => void;
    onWaitingFor: (item: StoredItem) => void;
    onTrash: (item: StoredItem) => void;
    /** Opens the "Move to…" sheet — the touch way to change the item's place in the inbox. */
    onMoveTo: (item: StoredItem) => void;
}

function InboxBottomSheet({ item, onClose, onEdit, onDone, onNextAction, onCalendar, onWaitingFor, onTrash, onMoveTo }: InboxBottomSheetProps) {
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
                <ListItemButton onClick={() => action(onEdit)}>
                    <ListItemIcon>
                        <EditIcon />
                    </ListItemIcon>
                    <ListItemText primary="Edit" />
                </ListItemButton>
                <ListItemButton onClick={() => action(onMoveTo)} data-testid="inboxSheetMoveTo">
                    <ListItemIcon>
                        <MoreVertIcon />
                    </ListItemIcon>
                    <ListItemText primary="Move to…" />
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
    useDocumentTitle('Inbox');
    const { db } = Route.useRouteContext();
    const { q } = Route.useSearch();
    const { account, items, workContexts, people, routines, refreshItems, isInitialSyncing } = useAppData();
    const navigate = useNavigate();
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
    const captureFieldRef = useAutoFocus();

    // Inbox is the only page where 'instant' fires the no-fields nextAction shortcut.
    const editor = useItemEditor({ db, people, workContexts, refreshItems, allowInstantNextAction: true, isMobile });

    const [draft, setDraft] = useState('');
    const [notes, setNotes] = useState('');
    const notesPanel = useCaptureNotesPanel();
    // Shared "captured into a hidden account" snackbar — same surface the quick-capture FAB uses.
    const { noticeCaptureIfHidden, hiddenAccountNotice } = useHiddenAccountCaptureNotice();

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
                notesPanel.openForRestoredDraft();
            }
            // Re-baseline so restoring doesn't immediately rewrite the same draft row.
            draftAutosave.reset({ title: stored.title, notes: stored.notes });
        });
        return () => {
            cancelled = true;
        };
        // draftAutosave and the notes-panel actions are stable; account/db are boot-stable.
    }, [account, db, draftAutosave, notesPanel.openForRestoredDraft]);

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

    const writeUrlQuery = useCallback((query: string) => void navigate({ to: '/inbox', search: { q: query || undefined }, replace: true }), [navigate]);
    const search = useListSearch({ urlQuery: q ?? '', writeUrlQuery });

    // Deferred query: typing re-filters in an interruptible background render (see useListSearch).
    const { deferredQuery } = search;
    // The manual order (`rank`; a capture is minted at the top, so untouched it stays newest-first).
    const inboxItems = useMemo(
        () =>
            [
                ...filterItemsByQuery(
                    itemsWithGhosts.filter((item) => item.status === 'inbox'),
                    deferredQuery,
                ),
            ].sort(compareByRank),
        [itemsWithGhosts, deferredQuery],
    );
    // One section, no header: the whole inbox is one manual order (see lib/rankSections).
    const inboxSections = useMemo(() => [flatSection('inbox', 'Inbox', inboxItems)], [inboxItems]);
    // Every account of the merged inbox (visible rows or not) shares the keyspace a re-key must see.
    const inboxOwnerIds = useMemo(() => ownerIdsOfStatus(items, 'inbox'), [items]);
    const ranked = useRankedList({ db, sections: inboxSections, isGhost, ownerIds: inboxOwnerIds, refreshItems, hasHeaders: false, regionLabel: 'Inbox' });
    const [inboxSection] = inboxSections;

    // Lookup map so each row doesn't rescan the routines array for its indicator title.
    const routineTitleById = useMemo(() => new Map(routines.map((r) => [r._id, r.title])), [routines]);

    // Ghosts are fading leftovers of items just clarified away — counts and the batch wizard use live rows only.
    const liveInboxItems = inboxItems.filter((item) => !isGhost(item));

    async function onCapture() {
        const title = draft.trim();
        if (!title || !account) {
            return;
        }
        setDraft('');
        setNotes('');
        notesPanel.resetAfterCapture();
        // The text is committed as a real item — drop the draft row and re-baseline the autosave
        // so a pending debounce tick can't resurrect the just-captured text. reset() drops the
        // scheduled timer; flush() then drains any commit already in flight before the delete.
        draftAutosave.reset({ title: '', notes: '' });
        await draftAutosave.flush();
        await deleteInboxCaptureDraft(db, account.id);
        await collectItem(db, account.id, { title, notes });
        await refreshItems();
        noticeCaptureIfHidden(account.id);
    }

    async function onKeyDown(e: React.KeyboardEvent) {
        if (e.key === 'Enter') await onCapture();
    }

    // Both take focus on to the next row once the row leaves (a keyboard user must not be left on its ghost).
    async function onQuickDone(item: StoredItem) {
        const handOff = ranked.focusHandOffFrom(item._id);
        await clarifyToDone(db, item, { onReadOnlyGCal: editor.onFromGmailReadOnly });
        await refreshItems();
        handOff();
    }

    async function onTrash(item: StoredItem) {
        const handOff = ranked.focusHandOffFrom(item._id);
        await clarifyToTrash(db, item);
        await refreshItems();
        handOff();
    }

    function openWithStatus(item: StoredItem, status: EditableStatus, clickEvent?: React.MouseEvent<HTMLElement>) {
        editor.openEditor({ item, initialStatus: status, ...(clickEvent ? { anchor: clickEvent.currentTarget, event: clickEvent } : {}) });
    }

    // Deliberate: with an in-page search active, the wizard batches only the matching items
    // (liveInboxItems derives from the query-filtered list) — "process what I searched for".
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
                    <ListSearchButton onToggle={search.toggleSearch} testId="inboxSearchButton" />
                </Box>
                <Button variant="outlined" size="small" disabled={liveInboxItems.length === 0} onClick={startProcessInbox} data-testid="processInboxButton">
                    Process Inbox ({liveInboxItems.length})
                </Button>
            </Box>
            {search.isOpen && (
                <ListSearchField
                    value={search.queryInput}
                    onValueChange={search.setQueryInput}
                    onClose={search.closeSearch}
                    placeholder="Search inbox…"
                    testId="inboxSearchInput"
                />
            )}
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
                                    <Tooltip title={notesPanel.isOpen ? 'Hide note' : 'Add note'}>
                                        {/* color="primary" when notes have content so user knows a note is attached */}
                                        <IconButton
                                            onClick={notesPanel.toggleByUser}
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
                {notesPanel.isOpen && (
                    <Box className={styles.captureNotes}>
                        <Tabs value={notesPanel.tab} onChange={(_, tab: 0 | 1) => notesPanel.selectTab(tab)} className={styles.tabs}>
                            <Tab label="Edit" value={0} />
                            <Tab label="Preview" value={1} />
                        </Tabs>
                        {notesPanel.tab === 0 ? (
                            <MarkdownNotesEditor
                                value={notes}
                                onValueChange={(next) => onCaptureFieldsChange(draft, next)}
                                placeholder={NOTES_PLACEHOLDER}
                                autoFocus={notesPanel.shouldFocusEditor}
                            />
                        ) : (
                            <div className={styles.notesPreview}>
                                {notes.trim() ? <MarkdownPreview markdown={notes} /> : <span className={styles.notesEmpty}>Nothing to preview.</span>}
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
                        {/* An active search that matches nothing is "no results", not inbox zero. */}
                        {deferredQuery.trim() ? 'No inbox items match your search.' : 'Inbox zero — well done.'}
                    </Typography>
                )
            ) : (
                // component="div": WindowVirtualizer renders a measuring <div> wrapper, invalid inside
                // the default <ul>. Windowed rendering — only rows near the viewport mount, so a large
                // inbox doesn't block the main thread on navigation.
                // One tab stop for the whole list on desktop (see useNextActionsRovingFocus); phones use the swipe rows, each with a long-press reorder handle.
                <List
                    disablePadding
                    component="div"
                    role="list"
                    className={styles.list}
                    aria-label="Inbox"
                    // The reorder key hint describes keyboard reordering, which phones (swipe rows) do not have.
                    {...(isMobile ? {} : { 'aria-describedby': ranked.hintIds.list })}
                    data-testid="inboxList"
                    {...(isMobile ? {} : ranked.roving.listProps)}
                >
                    <WindowVirtualizer ref={ranked.virtualizerRef}>
                        {itemRows(ranked.flatRows).map((row) => {
                            const { item, section, isLastInSection } = row;
                            return (
                                <ListRowShell key={item._id} itemId={item._id} isGhost={isGhost(item)} onGhostExited={onGhostExited}>
                                    {isMobile ? (
                                        <InboxSwipeItem
                                            item={item}
                                            routineTitle={item.routineId ? routineTitleById.get(item.routineId) : undefined}
                                            onTap={(i) => editor.openEditor({ item: i })}
                                            onMore={setBottomSheetItem}
                                            onSwipeNextAction={(i) => editor.openEditor({ item: i, initialStatus: 'nextAction' })}
                                            onSwipeTrash={(i) => void onTrash(i)}
                                            ranked={ranked}
                                            row={row}
                                            isGhost={isGhost(item)}
                                        />
                                    ) : (
                                        <ListItem
                                            disablePadding
                                            {...rankedRowProps(ranked, row, styles.item)}
                                            secondaryAction={
                                                <Box className={styles.actionButtons}>
                                                    {/* Everything but Copy id is hidden on a ghost: pressing Done or Trash on its stale snapshot (even by keyboard) would act twice. */}
                                                    {!isGhost(item) && (
                                                        <RowActionButton
                                                            rowAction="moveTo"
                                                            label="Move to…"
                                                            icon={<MoreVertIcon fontSize="small" />}
                                                            onClick={() => ranked.openMoveTo(item, section)}
                                                            data-testid="inboxItemMoveToButton"
                                                            {...ranked.roving.actionButtonProps}
                                                        />
                                                    )}
                                                    <CopyIdButton
                                                        isRowAction
                                                        id={item._id}
                                                        testId="inboxItemCopyIdButton"
                                                        buttonProps={ranked.roving.actionButtonProps}
                                                    />
                                                    {!isGhost(item) && (
                                                        <>
                                                            <RowActionButton
                                                                rowAction="edit"
                                                                label="Edit"
                                                                icon={<EditIcon fontSize="small" />}
                                                                onClick={(e) => editor.openEditor({ item, event: e })}
                                                                data-testid="inboxItemEditButton"
                                                                {...ranked.roving.actionButtonProps}
                                                            />
                                                            <Tooltip title="Done (< 2 min)">
                                                                <IconButton
                                                                    size="small"
                                                                    onClick={() => void onQuickDone(item)}
                                                                    {...ranked.roving.actionButtonProps}
                                                                >
                                                                    <PlaylistAddCheckIcon fontSize="small" />
                                                                </IconButton>
                                                            </Tooltip>
                                                            <Tooltip title="Next Action">
                                                                <IconButton
                                                                    size="small"
                                                                    onClick={(e) => openWithStatus(item, 'nextAction', e)}
                                                                    {...ranked.roving.actionButtonProps}
                                                                >
                                                                    <ArrowForwardIcon fontSize="small" />
                                                                </IconButton>
                                                            </Tooltip>
                                                            <Tooltip title="Calendar">
                                                                <IconButton
                                                                    size="small"
                                                                    onClick={(e) => openWithStatus(item, 'calendar', e)}
                                                                    {...ranked.roving.actionButtonProps}
                                                                >
                                                                    <CalendarTodayIcon fontSize="small" />
                                                                </IconButton>
                                                            </Tooltip>
                                                            <Tooltip title="Waiting For">
                                                                <IconButton
                                                                    size="small"
                                                                    onClick={(e) => openWithStatus(item, 'waitingFor', e)}
                                                                    {...ranked.roving.actionButtonProps}
                                                                >
                                                                    <HourglassEmptyIcon fontSize="small" />
                                                                </IconButton>
                                                            </Tooltip>
                                                            <Tooltip title="Trash">
                                                                <IconButton
                                                                    size="small"
                                                                    color="error"
                                                                    onClick={() => void onTrash(item)}
                                                                    {...ranked.roving.actionButtonProps}
                                                                >
                                                                    <DeleteOutlineIcon fontSize="small" />
                                                                </IconButton>
                                                            </Tooltip>
                                                        </>
                                                    )}
                                                </Box>
                                            }
                                        >
                                            {!isGhost(item) && <RankedRowHandle ranked={ranked} item={item} section={section} testId="inboxDragHandle" />}
                                            <ListItemButton
                                                onClick={(e) => editor.openEditor({ item, event: e })}
                                                {...rankedRowButtonProps(ranked)}
                                                data-testid="inboxItemRow"
                                            >
                                                <ListItemText
                                                    primary={
                                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                                            <span>{item.title}</span>
                                                            {item.routineId && (
                                                                <RoutineIndicator
                                                                    routineId={item.routineId}
                                                                    routineTitle={routineTitleById.get(item.routineId)}
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

                                    {!isLastInSection && <Divider />}
                                </ListRowShell>
                            );
                        })}
                    </WindowVirtualizer>
                </List>
            )}

            {editor.renderGlobal()}
            <Snackbar open={editor.instantToast.open} autoHideDuration={3000} onClose={editor.closeInstantToast} message={editor.instantToast.message} />
            {hiddenAccountNotice}

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

            {/* Keyboard hints, the reorder announcer, the failure toast and the Move to sheet. */}
            <RankedListChrome ranked={ranked} actions={RANKED_LIST_ROW_ACTIONS} sectionNoun="list" liveTestId="inboxReorderLive" />

            <InboxBottomSheet
                item={bottomSheetItem}
                onMoveTo={(i) => {
                    if (inboxSection) {
                        ranked.openMoveTo(i, inboxSection);
                    }
                }}
                onClose={() => setBottomSheetItem(null)}
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
