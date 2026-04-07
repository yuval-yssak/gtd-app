import AddIcon from '@mui/icons-material/Add';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import NoteAddIcon from '@mui/icons-material/NoteAdd';
import PlaylistAddCheckIcon from '@mui/icons-material/PlaylistAddCheck';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Popover from '@mui/material/Popover';
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
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { ClarifyDialog } from '../../components/ClarifyDialog';
import { CalendarFields } from '../../components/clarify/CalendarFields';
import { NextActionFields } from '../../components/clarify/NextActionFields';
import {
    buildCalendarMeta,
    buildNextActionMeta,
    buildWaitingForMeta,
    type CalendarFormState,
    type Destination,
    emptyCalendar,
    emptyNextAction,
    emptyWaitingFor,
    type NextActionFormState,
    type WaitingForFormState,
} from '../../components/clarify/types';
import { WaitingForFields } from '../../components/clarify/WaitingForFields';
import { EditItemDialog } from '../../components/EditItemDialog';
import { RoutineIndicator } from '../../components/RoutineIndicator';
import { useAppData } from '../../contexts/AppDataProvider';
import { clarifyToCalendar, clarifyToDone, clarifyToNextAction, clarifyToTrash, clarifyToWaitingFor, collectItem } from '../../db/itemMutations';
import { useCalendarOptions } from '../../hooks/useCalendarOptions';
import { useSwipeGesture } from '../../hooks/useSwipeGesture';
import { CLARIFY_MODE_KEY, type InlineClarifyMode, parseClarifyMode } from '../../lib/clarifyMode';
import type { StoredItem } from '../../types/MyDB';
import styles from './-inbox.module.css';

dayjs.extend(relativeTime);

// Destinations that require a form (calendar needs a date, waitingFor needs a person).
// In instant mode these fall back to dialog so required fields can be filled.
type ActionableDest = 'nextAction' | 'calendar' | 'waitingFor';

export const Route = createFileRoute('/_authenticated/inbox')({
    component: InboxPage,
});

// --- Mobile swipe row ---

interface InboxSwipeItemProps {
    item: StoredItem;
    // exactOptionalPropertyTypes requires explicit `| undefined` to allow passing `.find()?.title`
    routineTitle?: string | undefined;
    onTap: (item: StoredItem) => void;
    onSwipeNextAction: (item: StoredItem) => void;
    onSwipeTrash: (item: StoredItem) => void;
}

function InboxSwipeItem({ item, routineTitle, onTap, onSwipeNextAction, onSwipeTrash }: InboxSwipeItemProps) {
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
    // Show the reveal as soon as the finger moves at all (> 0), not at the tap-suppression
    // threshold (10px) — using 10px here caused a blank frame during snap-back.
    const showRight = translateX > 0;
    const showLeft = translateX < 0;

    // Destructure to avoid spreading touchHandlers and then overriding onTouchEnd, which
    // is fragile — a reorder of the spread would silently drop the override.
    const { onTouchStart, onTouchMove, onTouchEnd } = touchHandlers;

    return (
        <Box className={styles.swipeWrapper}>
            {/* Reveal layer behind the row — colour and icon reflect direction */}
            {showRight && (
                <Box className={styles.revealRight}>
                    <ArrowForwardIcon fontSize="small" />
                    <Typography variant="body2" ml={1}>
                        Next Action
                    </Typography>
                </Box>
            )}
            {showLeft && (
                <Box className={styles.revealLeft}>
                    <Typography variant="body2" mr={1}>
                        Trash
                    </Typography>
                    <DeleteOutlineIcon fontSize="small" />
                </Box>
            )}
            <ListItem
                disablePadding
                className={styles.item}
                // Transition only on release so dragging feels direct; animate snap-back.
                // isCommitted is not needed here — React 19 batches both setTranslateX(0) and
                // setCommittedDirection in the same render, so translateX === 0 is sufficient.
                style={{
                    transform: `translateX(${translateX}px)`,
                    transition: translateX === 0 ? 'transform 0.2s ease' : 'none',
                }}
                onTouchStart={onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEnd}
                onClick={handleClick}
            >
                <ListItemText
                    primary={
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                            <span>{item.title}</span>
                            {item.routineId && <RoutineIndicator routineId={item.routineId} routineTitle={routineTitle} />}
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
}

function InboxBottomSheet({ item, onClose, onEdit, onDone, onNextAction, onCalendar, onWaitingFor, onTrash }: InboxBottomSheetProps) {
    if (!item) return null;

    // TypeScript doesn't preserve narrowing of outer variables inside nested function
    // declarations, so pin the narrowed value to a const that closures can reference safely.
    const resolvedItem = item;

    function action(fn: (i: StoredItem) => void) {
        fn(resolvedItem);
        onClose();
    }

    return (
        // SwipeableDrawer lets users swipe the sheet down to dismiss — natural on mobile.
        // onOpen is required by MUI's API but unused here because open state is driven externally.
        <SwipeableDrawer anchor="bottom" open={Boolean(item)} onClose={onClose} onOpen={() => {}}>
            <Box className={styles.sheetHandle} />
            <Typography variant="subtitle1" fontWeight={600} px={2} pb={1}>
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
                    <ListItemText primary="Trash" primaryTypographyProps={{ color: 'error' }} />
                </ListItemButton>
            </List>
            <Box pb={2} />
        </SwipeableDrawer>
    );
}

// --- Page ---

function InboxPage() {
    const { db } = Route.useRouteContext();
    const { account, items, workContexts, people, routines, refreshItems } = useAppData();
    const { options: calendarOptions } = useCalendarOptions();
    const theme = useTheme();
    // Hide inline buttons and switch to swipe+bottom-sheet on screens narrower than 900px
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
    const navigate = useNavigate();

    const [draft, setDraft] = useState('');
    const [notes, setNotes] = useState('');
    const [notesOpen, setNotesOpen] = useState(false);
    const [notesTab, setNotesTab] = useState<0 | 1>(0);

    // Batch "Process Inbox" wizard
    const [batchClarifyOpen, setBatchClarifyOpen] = useState(false);

    // Dialog mode: single-item ClarifyDialog with pre-selected destination
    const [clarifyItem, setClarifyItem] = useState<StoredItem | null>(null);
    const [clarifyDest, setClarifyDest] = useState<Destination | null>(null);

    // Inline expand mode
    const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
    const [expandedDest, setExpandedDest] = useState<ActionableDest | null>(null);

    // Popover mode
    const [popoverAnchor, setPopoverAnchor] = useState<HTMLElement | null>(null);
    const [popoverItem, setPopoverItem] = useState<StoredItem | null>(null);
    const [popoverDest, setPopoverDest] = useState<ActionableDest | null>(null);

    // Instant mode toast
    const [toastOpen, setToastOpen] = useState(false);
    const [isSubmittingInline, setIsSubmittingInline] = useState(false);
    // Ref mirror of isSubmittingInline — state updates are async so a rapid double-swipe would
    // read stale false from both closures; a ref is mutated synchronously and always current.
    const isSubmittingInlineRef = useRef(false);

    // Shared form state for expand/popover modes
    const [naForm, setNaForm] = useState<NextActionFormState>(emptyNextAction);
    const [calForm, setCalForm] = useState<CalendarFormState>(emptyCalendar);
    const [wfForm, setWfForm] = useState<WaitingForFormState>(emptyWaitingFor);

    const [editingItem, setEditingItem] = useState<StoredItem | null>(null);

    // Mobile bottom sheet
    const [bottomSheetItem, setBottomSheetItem] = useState<StoredItem | null>(null);

    // Read preference from localStorage; update reactively when settings page changes it.
    // The storage event normally fires only in other tabs, so settings.tsx dispatches it manually.
    const [clarifyMode, setClarifyMode] = useState<InlineClarifyMode>(() => parseClarifyMode(localStorage.getItem(CLARIFY_MODE_KEY)));
    useEffect(() => {
        function onStorage(e: StorageEvent) {
            if (e.key === CLARIFY_MODE_KEY) {
                setClarifyMode(parseClarifyMode(e.newValue));
            }
        }
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    const inboxItems = items.filter((item) => item.status === 'inbox').sort((a, b) => b.createdTs.localeCompare(a.createdTs));

    function resetForms() {
        setNaForm(emptyNextAction);
        setCalForm(emptyCalendar);
        setWfForm(emptyWaitingFor);
    }

    function closeInlineForm() {
        setExpandedItemId(null);
        setExpandedDest(null);
        setPopoverAnchor(null);
        setPopoverItem(null);
        setPopoverDest(null);
        resetForms();
    }

    function isInlineConfirmDisabled(dest: ActionableDest): boolean {
        if (dest === 'calendar') return !calForm.date;
        if (dest === 'waitingFor') return !wfForm.waitingForPersonId;
        return false;
    }

    async function onConfirmInlineForm(item: StoredItem, dest: ActionableDest) {
        if (isSubmittingInlineRef.current) {
            return;
        }
        isSubmittingInlineRef.current = true;
        setIsSubmittingInline(true);
        try {
            if (dest === 'nextAction') {
                await clarifyToNextAction(db, item, buildNextActionMeta(naForm));
            } else if (dest === 'calendar') {
                await clarifyToCalendar(db, item, buildCalendarMeta(calForm, calendarOptions));
            } else if (dest === 'waitingFor') {
                await clarifyToWaitingFor(db, item, buildWaitingForMeta(wfForm));
            }
            await refreshItems();
            closeInlineForm();
        } finally {
            isSubmittingInlineRef.current = false;
            setIsSubmittingInline(false);
        }
    }

    // Extracted to avoid duplication between desktop onInlineAction and mobile onInlineActionFromSheet.
    // isSubmittingInlineRef guards against double-firing (e.g. rapid swipes before the first op resolves).
    function instantNextAction(item: StoredItem) {
        if (isSubmittingInlineRef.current) {
            return;
        }
        isSubmittingInlineRef.current = true;
        setIsSubmittingInline(true);
        void clarifyToNextAction(db, item, {})
            .then(refreshItems)
            .finally(() => {
                isSubmittingInlineRef.current = false;
                setIsSubmittingInline(false);
            });
        setToastOpen(true);
    }

    function onInlineAction(e: React.MouseEvent<HTMLElement>, item: StoredItem, dest: ActionableDest) {
        // instant mode is only truly instant for nextAction — calendar and waitingFor require
        // mandatory fields (date, person), so they fall back to dialog even in instant mode.
        if (clarifyMode === 'instant' && dest === 'nextAction') {
            instantNextAction(item);
            return;
        }

        if (clarifyMode === 'dialog' || (clarifyMode === 'instant' && dest !== 'nextAction')) {
            setClarifyItem(item);
            setClarifyDest(dest);
            return;
        }

        if (clarifyMode === 'expand') {
            // Toggle off if the same item+dest is already expanded
            if (expandedItemId === item._id && expandedDest === dest) {
                closeInlineForm();
            } else {
                resetForms();
                setExpandedItemId(item._id);
                setExpandedDest(dest);
            }
            return;
        }

        if (clarifyMode === 'popover') {
            resetForms();
            setPopoverAnchor(e.currentTarget);
            setPopoverItem(item);
            setPopoverDest(dest);
            return;
        }

        if (clarifyMode === 'page') {
            // Pass `dest` as a search param so the item page pre-selects the chip the user clicked.
            // `_authenticated` is a pathless layout — TanStack Router registers the route as `/item/$itemId`.
            void navigate({ to: '/item/$itemId', params: { itemId: item._id }, search: { dest } });
        }
    }

    // Respects clarify mode for mobile swipe and bottom-sheet actions.
    // expand/popover fall back to dialog — expand targets hidden rows and popover anchors
    // to document.body nonsensically on touch.
    function onInlineActionFromSheet(item: StoredItem, dest: ActionableDest) {
        if (clarifyMode === 'instant' && dest === 'nextAction') {
            instantNextAction(item);
            return;
        }
        if (clarifyMode === 'page') {
            void navigate({ to: '/item/$itemId', params: { itemId: item._id }, search: { dest } });
            return;
        }
        // dialog, expand, popover all open ClarifyDialog on mobile
        setClarifyItem(item);
        setClarifyDest(dest);
    }

    async function onCapture() {
        const title = draft.trim();
        if (!title || !account) {
            return;
        }
        setDraft('');
        setNotes('');
        setNotesOpen(false);
        setNotesTab(0);
        await collectItem(db, account.id, { title, notes });
        await refreshItems();
    }

    async function onKeyDown(e: React.KeyboardEvent) {
        if (e.key === 'Enter') await onCapture();
    }

    async function onQuickDone(item: StoredItem) {
        await clarifyToDone(db, item);
        await refreshItems();
    }

    async function onTrash(item: StoredItem) {
        await clarifyToTrash(db, item);
        await refreshItems();
    }

    return (
        <Box>
            <Box className={styles.pageHeader}>
                <Typography variant="h5" fontWeight={600}>
                    Inbox
                    {inboxItems.length > 0 && <Chip label={inboxItems.length} size="small" color="primary" className={styles.countChip} />}
                </Typography>
                <Button variant="outlined" size="small" disabled={inboxItems.length === 0} onClick={() => setBatchClarifyOpen(true)}>
                    Process Inbox ({inboxItems.length})
                </Button>
            </Box>

            <Paper variant="outlined" className={styles.captureCard}>
                <TextField
                    fullWidth
                    placeholder="What's on your mind?"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onKeyDown}
                    slotProps={{
                        input: {
                            endAdornment: (
                                <InputAdornment position="end">
                                    <Tooltip title={notesOpen ? 'Hide note' : 'Add note'}>
                                        {/* color="primary" when notes have content so user knows a note is attached */}
                                        <IconButton onClick={() => setNotesOpen((o) => !o)} color={notes.trim() ? 'primary' : 'default'}>
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
                                onChange={(e) => setNotes(e.target.value)}
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
                <Typography color="text.secondary" textAlign="center" mt={6}>
                    Inbox zero — well done.
                </Typography>
            ) : (
                <List disablePadding className={styles.list}>
                    {inboxItems.map((item, idx) => (
                        <Box key={item._id}>
                            {isMobile ? (
                                <InboxSwipeItem
                                    item={item}
                                    routineTitle={routines.find((r) => r._id === item.routineId)?.title}
                                    onTap={setBottomSheetItem}
                                    onSwipeNextAction={(i) => onInlineActionFromSheet(i, 'nextAction')}
                                    onSwipeTrash={(i) => void onTrash(i)}
                                />
                            ) : (
                                <ListItem
                                    disablePadding
                                    className={styles.item}
                                    // 6 icon buttons fit within the 220px padding-right set in inbox.module.css
                                    secondaryAction={
                                        <Box className={styles.actionButtons}>
                                            <Tooltip title="Edit">
                                                <IconButton size="small" onClick={() => setEditingItem(item)}>
                                                    <EditIcon fontSize="small" />
                                                </IconButton>
                                            </Tooltip>
                                            <Tooltip title="Done (< 2 min)">
                                                <IconButton size="small" onClick={() => void onQuickDone(item)}>
                                                    <PlaylistAddCheckIcon fontSize="small" />
                                                </IconButton>
                                            </Tooltip>
                                            <Tooltip title="Next Action">
                                                <IconButton size="small" onClick={(e) => onInlineAction(e, item, 'nextAction')}>
                                                    <ArrowForwardIcon fontSize="small" />
                                                </IconButton>
                                            </Tooltip>
                                            <Tooltip title="Calendar">
                                                <IconButton size="small" onClick={(e) => onInlineAction(e, item, 'calendar')}>
                                                    <CalendarTodayIcon fontSize="small" />
                                                </IconButton>
                                            </Tooltip>
                                            <Tooltip title="Waiting For">
                                                <IconButton size="small" onClick={(e) => onInlineAction(e, item, 'waitingFor')}>
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
                                            </Box>
                                        }
                                        secondary={dayjs(item.createdTs).fromNow()}
                                        className={styles.listItemText}
                                    />
                                </ListItem>
                            )}

                            {/* Inline expand mode: form appears below the item row */}
                            {clarifyMode === 'expand' && expandedItemId === item._id && expandedDest && (
                                <Collapse in>
                                    <Box className={styles.expandedForm}>
                                        {expandedDest === 'nextAction' && (
                                            <NextActionFields
                                                value={naForm}
                                                onChange={(patch) => setNaForm((f) => ({ ...f, ...patch }))}
                                                workContexts={workContexts}
                                                people={people}
                                            />
                                        )}
                                        {expandedDest === 'calendar' && (
                                            <CalendarFields
                                                value={calForm}
                                                onChange={(patch) => setCalForm((f) => ({ ...f, ...patch }))}
                                                calendarOptions={calendarOptions}
                                            />
                                        )}
                                        {expandedDest === 'waitingFor' && (
                                            <WaitingForFields value={wfForm} onChange={(patch) => setWfForm((f) => ({ ...f, ...patch }))} people={people} />
                                        )}
                                        <Box className={styles.expandedFormActions}>
                                            <Button size="small" onClick={closeInlineForm}>
                                                Cancel
                                            </Button>
                                            <Button
                                                size="small"
                                                variant="contained"
                                                disabled={isInlineConfirmDisabled(expandedDest) || isSubmittingInline}
                                                onClick={() => void onConfirmInlineForm(item, expandedDest)}
                                            >
                                                Confirm
                                            </Button>
                                        </Box>
                                    </Box>
                                </Collapse>
                            )}

                            {idx < inboxItems.length - 1 && <Divider />}
                        </Box>
                    ))}
                </List>
            )}

            {/* Popover mode: floating panel anchored to the clicked button */}
            <Popover
                open={Boolean(popoverAnchor)}
                anchorEl={popoverAnchor}
                onClose={closeInlineForm}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                transformOrigin={{ vertical: 'top', horizontal: 'right' }}
            >
                {popoverItem && popoverDest && (
                    <Box className={styles.popoverContent}>
                        {popoverDest === 'nextAction' && (
                            <NextActionFields
                                value={naForm}
                                onChange={(patch) => setNaForm((f) => ({ ...f, ...patch }))}
                                workContexts={workContexts}
                                people={people}
                            />
                        )}
                        {popoverDest === 'calendar' && (
                            <CalendarFields value={calForm} onChange={(patch) => setCalForm((f) => ({ ...f, ...patch }))} calendarOptions={calendarOptions} />
                        )}
                        {popoverDest === 'waitingFor' && (
                            <WaitingForFields value={wfForm} onChange={(patch) => setWfForm((f) => ({ ...f, ...patch }))} people={people} />
                        )}
                        <Box className={styles.popoverActions}>
                            <Button size="small" onClick={closeInlineForm}>
                                Cancel
                            </Button>
                            <Button
                                size="small"
                                variant="contained"
                                disabled={isInlineConfirmDisabled(popoverDest) || isSubmittingInline}
                                onClick={() => void onConfirmInlineForm(popoverItem, popoverDest)}
                            >
                                Confirm
                            </Button>
                        </Box>
                    </Box>
                )}
            </Popover>

            {/* Instant mode toast — prompts user to add details after the instant move */}
            <Snackbar open={toastOpen} autoHideDuration={5000} onClose={() => setToastOpen(false)} message="Moved to Next Actions" />

            {batchClarifyOpen && (
                <ClarifyDialog
                    items={inboxItems}
                    db={db}
                    people={people}
                    workContexts={workContexts}
                    onClose={() => setBatchClarifyOpen(false)}
                    onItemProcessed={refreshItems}
                />
            )}
            {clarifyItem && (
                <ClarifyDialog
                    items={[clarifyItem]}
                    db={db}
                    people={people}
                    workContexts={workContexts}
                    onClose={() => {
                        setClarifyItem(null);
                        setClarifyDest(null);
                    }}
                    onItemProcessed={refreshItems}
                    // exactOptionalPropertyTypes: omit the prop entirely rather than passing undefined
                    {...(clarifyDest ? { initialDestination: clarifyDest } : {})}
                />
            )}
            {editingItem && <EditItemDialog item={editingItem} db={db} onClose={() => setEditingItem(null)} onSaved={refreshItems} />}

            <InboxBottomSheet
                item={bottomSheetItem}
                onClose={() => setBottomSheetItem(null)}
                onEdit={(i) => setEditingItem(i)}
                onDone={(i) => void onQuickDone(i)}
                onNextAction={(i) => onInlineActionFromSheet(i, 'nextAction')}
                onCalendar={(i) => onInlineActionFromSheet(i, 'calendar')}
                onWaitingFor={(i) => onInlineActionFromSheet(i, 'waitingFor')}
                onTrash={(i) => void onTrash(i)}
            />
        </Box>
    );
}
