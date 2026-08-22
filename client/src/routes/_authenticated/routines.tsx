import AddIcon from '@mui/icons-material/Add';
import CalendarViewWeekIcon from '@mui/icons-material/CalendarViewWeek';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import EditIcon from '@mui/icons-material/Edit';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import ViewListIcon from '@mui/icons-material/ViewList';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import { useTheme } from '@mui/material/styles';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useCallback, useMemo, useState } from 'react';
import { WindowVirtualizer } from 'virtua';
import { AccountChip } from '../../components/AccountChip';
import { AccountSyncChip } from '../../components/AccountSyncChip';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { ListSkeleton } from '../../components/ListSkeleton';
import { useRoutineEditor } from '../../components/routineEditor/useRoutineEditor';
import { RoutineWeekGrid } from '../../components/routines/RoutineWeekGrid';
import { SyncingChip } from '../../components/SyncingChip';
import { useAppData } from '../../contexts/AppDataProvider';
import { pauseRoutine, removeRoutine } from '../../db/routineMutations';
import { useAutoFocus } from '../../hooks/useAutoFocus';
import { useListScrollRestoration } from '../../hooks/useListScrollRestoration';
import { useListSearch } from '../../hooks/useListSearch';
import { useNewTabAwareNavigate } from '../../lib/newTabNavigation';
import { filterRoutinesByTitle, groupRoutinesByFrequency, splitActivePaused } from '../../lib/routineGrouping';
import { buildRoutineNextItemIndex, describeNextItemDate } from '../../lib/routineNextItem';
import { parseRoutinesSearch, type RoutinesTab, type RoutinesView } from '../../lib/routinesUrlParams';
import { formatRoutineSchedule } from '../../lib/rruleUtils';
import type { StoredRoutine } from '../../types/MyDB';
import styles from './-routines.module.css';

export const Route = createFileRoute('/_authenticated/routines')({
    component: RoutinesPage,
    validateSearch: parseRoutinesSearch,
});

function RoutinesPage() {
    const { db } = Route.useRouteContext();
    const { q, tab, view } = Route.useSearch();
    // Route-scoped so functional `search` updaters receive (and must return) this route's
    // typed search state instead of the all-routes union.
    const navigate = useNavigate({ from: Route.fullPath });
    const navigateOrNewTab = useNewTabAwareNavigate();
    const searchFieldRef = useAutoFocus();
    useListScrollRestoration();
    const { account, routines, items, workContexts, people, refreshRoutines, refreshItems, syncAndRefresh, isInitialSyncing, isCalendarSyncing } = useAppData();
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
    const editor = useRoutineEditor({
        db,
        userId: account?.id ?? '',
        people,
        workContexts,
        refreshRoutines,
        refreshItems,
        isMobile,
    });
    const [routineToDelete, setRoutineToDelete] = useState<StoredRoutine | null>(null);
    const [routineToPause, setRoutineToPause] = useState<StoredRoutine | null>(null);
    const [isPausedSectionOpen, setIsPausedSectionOpen] = useState(false);

    const activeTab: RoutinesTab = tab ?? 'nextAction';
    const activeView: RoutinesView = view ?? 'list';

    const writeUrlQuery = useCallback(
        (query: string) => void navigate({ to: '/routines', search: (prev) => ({ ...prev, q: query || undefined }), replace: true }),
        [navigate],
    );
    // Deferred query: keystrokes echo urgently while the regroup (rrule parsing per routine)
    // happens in an interruptible background render. The URL write is debounced (see useListSearch).
    const search = useListSearch({ urlQuery: q ?? '', writeUrlQuery });
    const { deferredQuery } = search;

    const filtered = useMemo(() => filterRoutinesByTitle(routines, deferredQuery), [routines, deferredQuery]);
    // Tab counts cover unpaused routines only — paused ones are archived away in their own
    // collapsed section, which carries its own count.
    const unpausedFiltered = useMemo(() => splitActivePaused(filtered).active, [filtered]);
    const nextActionCount = useMemo(() => unpausedFiltered.filter((routine) => routine.routineType === 'nextAction').length, [unpausedFiltered]);
    const calendarCount = unpausedFiltered.length - nextActionCount;
    const { active, paused } = useMemo(() => splitActivePaused(filtered.filter((routine) => routine.routineType === activeTab)), [filtered, activeTab]);
    const buckets = useMemo(() => groupRoutinesByFrequency(active), [active]);
    // "now" freezes until routines/items change — a tab left open past an occurrence's end keeps
    // showing it as next until the next sync tick refreshes `items`. Accepted staleness.
    const nextItemByRoutine = useMemo(() => buildRoutineNextItemIndex(active, items, dayjs()), [active, items]);

    // First-launch bootstrap and truly-empty accounts get no tabs/search/view chrome — just the
    // skeleton or the "no routines yet" copy.
    const hasAnyRoutines = routines.length > 0 || Boolean(q);
    const isBootstrapping = routines.length === 0 && isInitialSyncing;

    function onTabSelected(nextTab: RoutinesTab) {
        // 'nextAction' (the default) is materialized as undefined so it never appears in the URL.
        void navigate({ to: '/routines', search: (prev) => ({ ...prev, tab: nextTab === 'calendar' ? 'calendar' : undefined }), replace: true });
        // Each tab has its own paused set — don't carry an expanded section across.
        setIsPausedSectionOpen(false);
    }

    function onViewSelected(nextView: RoutinesView) {
        void navigate({ to: '/routines', search: (prev) => ({ ...prev, view: nextView === 'week' ? 'week' : undefined }), replace: true });
    }

    async function onConfirmDelete() {
        if (!routineToDelete) {
            return;
        }
        // Close dialog synchronously + snapshot the target: prevents a double-click from
        // re-entering this handler with the same routineToDelete (would enqueue a duplicate delete op).
        const target = routineToDelete;
        setRoutineToDelete(null);
        await removeRoutine(db, target._id);
        await refreshRoutines();
        // removeRoutine also trashes the routine's open items locally — refresh so the UI drops
        // them immediately instead of waiting for syncAndRefresh's network round trip.
        await refreshItems();
        // Push the delete + pull the server cascade (trashed generated calendar items)
        // so the Calendar view reflects the removal without waiting for an SSE tick.
        await syncAndRefresh();
    }

    async function onConfirmPause() {
        if (!routineToPause || !account) {
            return;
        }
        const target = routineToPause;
        setRoutineToPause(null);
        await pauseRoutine(db, account.id, target);
        await refreshRoutines();
        await refreshItems();
        // Sync + pull so the GCal-cap echo lands promptly.
        await syncAndRefresh();
    }

    function onRowClick(routine: StoredRoutine, e: React.MouseEvent<HTMLElement>) {
        editor.openEditor({ routine, anchor: e.currentTarget, event: e });
    }

    function openRoutinePage(routine: StoredRoutine, e: React.MouseEvent) {
        navigateOrNewTab(e, { to: '/routine/$routineId', params: { routineId: routine._id } });
    }

    /** Schedule + upcoming date on one line, e.g. "Every Thu at 18:00 for 1h · next Thu, Jul 2 18:00". */
    function routineSecondaryLabel(routine: StoredRoutine): string {
        const schedule = formatRoutineSchedule(routine);
        const next = nextItemByRoutine.get(routine._id);
        const nextLabel = next ? describeNextItemDate(next) : '';
        return nextLabel ? `${schedule} · next ${nextLabel}` : schedule;
    }

    function renderRoutineRow(routine: StoredRoutine) {
        return (
            <ListItem
                disablePadding
                className={styles.item}
                secondaryAction={
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                        <CopyIdButton id={routine._id} testId="routineRowCopyIdButton" />
                        <Tooltip title="Open routine page">
                            <IconButton size="small" onClick={(e) => openRoutinePage(routine, e)} data-testid="routineRowOpenPageButton">
                                <OpenInNewIcon fontSize="small" />
                            </IconButton>
                        </Tooltip>
                        {routine.active ? (
                            <Tooltip title="Pause">
                                <IconButton size="small" onClick={() => setRoutineToPause(routine)} data-testid="routineRowPauseButton">
                                    <PauseIcon fontSize="small" />
                                </IconButton>
                            </Tooltip>
                        ) : (
                            <Tooltip title="Resume — opens editor to set a new start date">
                                {/* No anchor passed: popover mode is too wide to attach to a 24px icon, so
                                    icon-button gestures fall through to dialog while row-body clicks still anchor. */}
                                <IconButton
                                    size="small"
                                    color="success"
                                    onClick={(e) => editor.openEditor({ routine, event: e })}
                                    data-testid="routineRowResumeButton"
                                >
                                    <PlayArrowIcon fontSize="small" />
                                </IconButton>
                            </Tooltip>
                        )}
                        <Tooltip title="Edit">
                            <IconButton size="small" onClick={(e) => editor.openEditor({ routine, event: e })} data-testid="routineRowEditButton">
                                <EditIcon fontSize="small" />
                            </IconButton>
                        </Tooltip>
                        <Tooltip title="Delete">
                            <IconButton size="small" color="error" onClick={() => setRoutineToDelete(routine)} data-testid="routineRowDeleteButton">
                                <DeleteOutlineIcon fontSize="small" />
                            </IconButton>
                        </Tooltip>
                    </Box>
                }
            >
                <ListItemButton onClick={(e) => onRowClick(routine, e)} data-testid="routineRow">
                    <ListItemText
                        primary={
                            <Box className={styles.titleRow}>
                                {routine.title}
                                <AccountChip userId={routine.userId} />
                            </Box>
                        }
                        secondary={routineSecondaryLabel(routine)}
                        className={styles.listItemText}
                    />
                </ListItemButton>
            </ListItem>
        );
    }

    function emptyStateMessage(): string {
        if (routines.length === 0) {
            return 'No routines yet. Routines auto-generate next actions on a schedule.';
        }
        if (deferredQuery.trim()) {
            return 'No routines match your search.';
        }
        return activeTab === 'calendar' ? 'No calendar routines yet.' : 'No next action routines yet.';
    }

    function renderEmptyState() {
        return (
            <Typography
                data-testid="routinesEmptyState"
                sx={{
                    color: 'text.secondary',
                    textAlign: 'center',
                    mt: 6,
                }}
            >
                {emptyStateMessage()}
            </Typography>
        );
    }

    function renderPausedSection() {
        if (paused.length === 0) {
            return null;
        }
        return (
            <Box className={styles.pausedSection}>
                <ListItemButton
                    onClick={() => setIsPausedSectionOpen((open) => !open)}
                    className={styles.pausedToggle}
                    data-testid="routinePausedSectionToggle"
                >
                    <ListItemText primary={`Paused (${paused.length})`} />
                    {isPausedSectionOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                </ListItemButton>
                {/* unmountOnExit: collapsed rows would otherwise stay in the DOM with
                    data-list-item-id anchors that skew scroll restoration. */}
                <Collapse in={isPausedSectionOpen} unmountOnExit>
                    <List disablePadding component="div" className={styles.list}>
                        {paused.map((routine, idx) => (
                            <Box key={routine._id} className={styles.pausedRow} data-list-item-id={routine._id}>
                                {renderRoutineRow(routine)}
                                {editor.renderExpandFor(routine._id)}
                                {idx < paused.length - 1 && <Divider />}
                            </Box>
                        ))}
                    </List>
                </Collapse>
            </Box>
        );
    }

    function renderListView() {
        if (buckets.length === 0 && paused.length === 0) {
            return renderEmptyState();
        }
        return (
            <>
                {buckets.length > 0 && (
                    // Buckets flattened into one windowed sequence (labels and rows are each a
                    // measured child) — only elements near the viewport mount, so a large routine
                    // collection doesn't block the main thread on navigation. component="div": the
                    // WindowVirtualizer measuring wrapper is invalid inside the default <ul>.
                    <List disablePadding component="div" className={styles.list}>
                        <WindowVirtualizer>
                            {buckets.flatMap((group) => [
                                <Typography
                                    key={`bucket-${group.bucket}`}
                                    variant="overline"
                                    className={styles.bucketLabel}
                                    data-testid="routineFrequencyBucket"
                                    sx={{ color: 'text.secondary' }}
                                >
                                    {group.bucket}
                                </Typography>,
                                ...group.routines.map((routine, idx) => (
                                    // data-list-item-id: scroll-restoration anchor (see useListScrollRestoration)
                                    <Box key={routine._id} data-list-item-id={routine._id}>
                                        {renderRoutineRow(routine)}
                                        {editor.renderExpandFor(routine._id)}
                                        {idx < group.routines.length - 1 && <Divider />}
                                    </Box>
                                )),
                            ])}
                        </WindowVirtualizer>
                    </List>
                )}
                {renderPausedSection()}
            </>
        );
    }

    function renderWeekView() {
        if (active.length === 0 && paused.length === 0) {
            return renderEmptyState();
        }
        return (
            <>
                <RoutineWeekGrid routines={active} onRoutineSelected={(routine, e) => editor.openEditor({ routine, event: e })} />
                {renderPausedSection()}
            </>
        );
    }

    return (
        <Box>
            <Box className={styles.pageHeader}>
                {/* Title + sync chip grouped so the chip stays beside the title; the parent's
                    space-between keeps the create button on the right. */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography
                        variant="h5"
                        sx={{
                            fontWeight: 600,
                        }}
                    >
                        Routines
                        {routines.length > 0 && <Chip label={routines.length} size="small" className={styles.countChip} />}
                    </Typography>
                    {/* Routines surface GCal-linked recurring series, so a calendar sync can change them. */}
                    {isCalendarSyncing && <SyncingChip label="Syncing calendar…" />}
                    <AccountSyncChip />
                </Box>
                <Tooltip title="Create routine">
                    <IconButton onClick={() => editor.openEditor({})} data-testid="newRoutineButton">
                        <AddIcon />
                    </IconButton>
                </Tooltip>
            </Box>
            {hasAnyRoutines && (
                <TextField
                    size="small"
                    fullWidth
                    placeholder="Search routines…"
                    value={search.queryInput}
                    onChange={(e) => search.setQueryInput(e.target.value)}
                    className={styles.searchField}
                    slotProps={{ htmlInput: { ref: searchFieldRef, 'data-testid': 'routinesSearchInput' } }}
                />
            )}
            {hasAnyRoutines && (
                <Box className={styles.controlsRow}>
                    <Tabs value={activeTab} onChange={(_e, value: RoutinesTab) => onTabSelected(value)} aria-label="Routine type">
                        <Tab value="nextAction" label={`Next Action (${nextActionCount})`} data-testid="routinesTabNextAction" />
                        <Tab value="calendar" label={`Calendar (${calendarCount})`} data-testid="routinesTabCalendar" />
                    </Tabs>
                    <ToggleButtonGroup
                        exclusive
                        size="small"
                        value={activeView}
                        onChange={(_e, value: RoutinesView | null) => {
                            if (value) onViewSelected(value);
                        }}
                    >
                        <ToggleButton value="list" aria-label="List view" data-testid="routinesViewListButton">
                            <ViewListIcon fontSize="small" />
                        </ToggleButton>
                        <ToggleButton value="week" aria-label="Week view" data-testid="routinesViewWeekButton">
                            <CalendarViewWeekIcon fontSize="small" />
                        </ToggleButton>
                    </ToggleButtonGroup>
                </Box>
            )}
            {isBootstrapping ? <ListSkeleton /> : activeView === 'week' ? renderWeekView() : renderListView()}
            {editor.renderGlobal()}
            <Dialog open={routineToDelete !== null} onClose={() => setRoutineToDelete(null)} maxWidth="sm" fullWidth>
                <DialogTitle>Delete routine?</DialogTitle>
                <DialogContent>
                    <DialogContentText>
                        {routineToDelete ? <>Delete "{routineToDelete.title}"?</> : null}
                        {routineToDelete?.routineType === 'calendar' && (
                            <>
                                <br />
                                <br />
                                This will also remove the recurring event from Google Calendar and trash all generated calendar items.
                            </>
                        )}
                    </DialogContentText>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setRoutineToDelete(null)}>Cancel</Button>
                    <Button color="error" onClick={() => void onConfirmDelete()}>
                        Delete
                    </Button>
                </DialogActions>
            </Dialog>
            <Dialog open={routineToPause !== null} onClose={() => setRoutineToPause(null)} maxWidth="sm" fullWidth>
                <DialogTitle>Pause routine?</DialogTitle>
                <DialogContent>
                    <DialogContentText>
                        {routineToPause ? <>Pause "{routineToPause.title}"?</> : null}
                        <br />
                        <br />
                        Future open items will be trashed. Past-due items are left alone.
                        {routineToPause?.routineType === 'calendar' && (
                            <>
                                <br />
                                The recurring event on Google Calendar will stop at today; past occurrences stay.
                            </>
                        )}
                        <br />
                        <br />
                        To resume, edit the routine and set a new start date.
                    </DialogContentText>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setRoutineToPause(null)}>Cancel</Button>
                    <Button variant="contained" onClick={() => void onConfirmPause()}>
                        Pause
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
