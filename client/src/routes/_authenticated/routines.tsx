import { createFileRoute, useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { CalendarDays, ChevronDown, ChevronUp, List, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { WindowVirtualizer } from 'virtua';
import { AccountChip } from '../../components/AccountChip';
import { AccountSyncChip } from '../../components/AccountSyncChip';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { ListEmptyMessage } from '../../components/ListEmptyMessage';
import { ListPageHeader } from '../../components/ListPageHeader';
import { ListSkeleton } from '../../components/ListSkeleton';
import { ListRow, ListRowButton, ListRowText } from '../../components/listRow/ListRow';
import { RowActionButton } from '../../components/RowActionButton';
import { useRoutineEditor } from '../../components/routineEditor/useRoutineEditor';
import { PauseRoutineConfirmDialog } from '../../components/routines/PauseRoutineConfirmDialog';
import { RoutineWeekGrid } from '../../components/routines/RoutineWeekGrid';
import { SyncingChip } from '../../components/SyncingChip';
import { useAppData } from '../../contexts/AppDataProvider';
import { pauseRoutine, removeRoutine } from '../../db/routineMutations';
import {
    AlertDialog,
    Button,
    Collapsible,
    DialogActions,
    DialogDescription,
    DialogTitle,
    IconButton,
    Tabs,
    Text,
    TextField,
    ToggleGroup,
    Tooltip,
} from '../../designSystem';
import { useAutoFocus } from '../../hooks/useAutoFocus';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useListScrollRestoration } from '../../hooks/useListScrollRestoration';
import { useListSearch } from '../../hooks/useListSearch';
import { filterRoutinesByTitle, groupRoutinesByFrequency, splitActivePaused } from '../../lib/routineGrouping';
import { buildRoutineNextItemIndex, describeNextItemDate } from '../../lib/routineNextItem';
import { parseRoutinesSearch, type RoutinesTab, type RoutinesView } from '../../lib/routinesUrlParams';
import { SHORTCUT_ROW_PROPS } from '../../lib/rowShortcuts';
import { formatRoutineSchedule } from '../../lib/rruleUtils';
import type { StoredRoutine } from '../../types/MyDB';
import styles from './-routines.module.css';

const VIEW_OPTIONS = [
    { value: 'list', label: <List size={18} />, 'aria-label': 'List view', 'data-testid': 'routinesViewListButton' },
    { value: 'week', label: <CalendarDays size={18} />, 'aria-label': 'Week view', 'data-testid': 'routinesViewWeekButton' },
] as const;

export const Route = createFileRoute('/_authenticated/routines')({
    component: RoutinesPage,
    validateSearch: parseRoutinesSearch,
});

function RoutinesPage() {
    useDocumentTitle('Routines');
    const { db } = Route.useRouteContext();
    const { q, tab, view } = Route.useSearch();
    // Route-scoped so functional `search` updaters receive (and must return) this route's
    // typed search state instead of the all-routes union.
    const navigate = useNavigate({ from: Route.fullPath });
    const searchFieldRef = useAutoFocus();
    useListScrollRestoration();
    const { account, routines, items, refreshRoutines, refreshItems, syncAndRefresh, isInitialSyncing, isCalendarSyncing } = useAppData();
    const editor = useRoutineEditor();
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

    /** Schedule + upcoming date on one line, e.g. "Every Thu at 18:00 for 1h · next Thu, Jul 2 18:00". */
    function routineSecondaryLabel(routine: StoredRoutine): string {
        const schedule = formatRoutineSchedule(routine);
        const next = nextItemByRoutine.get(routine._id);
        const nextLabel = next ? describeNextItemDate(next) : '';
        return nextLabel ? `${schedule} · next ${nextLabel}` : schedule;
    }

    function renderRoutineRow(routine: StoredRoutine, isDivided: boolean) {
        return (
            <ListRow
                {...SHORTCUT_ROW_PROPS}
                isDivided={isDivided}
                actions={
                    <>
                        <CopyIdButton isRowAction id={routine._id} testId="routineRowCopyIdButton" />
                        {routine.active ? (
                            <Tooltip title="Pause">
                                <IconButton size="sm" aria-label="Pause" onClick={() => setRoutineToPause(routine)} data-testid="routineRowPauseButton">
                                    <Pause />
                                </IconButton>
                            </Tooltip>
                        ) : (
                            <Tooltip title="Resume — opens editor to set a new start date">
                                <IconButton
                                    size="sm"
                                    tone="success"
                                    aria-label="Resume"
                                    onClick={(e) => editor.openEditor({ routine, event: e })}
                                    data-testid="routineRowResumeButton"
                                >
                                    <Play />
                                </IconButton>
                            </Tooltip>
                        )}
                        <RowActionButton
                            rowAction="edit"
                            label="Edit"
                            icon={<Pencil />}
                            onClick={(e) => editor.openEditor({ routine, event: e })}
                            data-testid="routineRowEditButton"
                        />
                        <Tooltip title="Delete">
                            <IconButton
                                size="sm"
                                tone="danger"
                                aria-label="Delete"
                                onClick={() => setRoutineToDelete(routine)}
                                data-testid="routineRowDeleteButton"
                            >
                                <Trash2 />
                            </IconButton>
                        </Tooltip>
                    </>
                }
            >
                <ListRowButton onActivate={(e) => editor.openEditor({ routine, event: e })} data-testid="routineRow">
                    <ListRowText
                        primary={
                            <>
                                <span>{routine.title}</span>
                                <AccountChip userId={routine.userId} />
                            </>
                        }
                        secondary={routineSecondaryLabel(routine)}
                    />
                </ListRowButton>
            </ListRow>
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
        return <ListEmptyMessage data-testid="routinesEmptyState">{emptyStateMessage()}</ListEmptyMessage>;
    }

    function renderPausedSection() {
        if (paused.length === 0) {
            return null;
        }
        return (
            <div className={styles.pausedSection}>
                <button
                    type="button"
                    className={styles.pausedToggle}
                    aria-expanded={isPausedSectionOpen}
                    onClick={() => setIsPausedSectionOpen((open) => !open)}
                    data-testid="routinePausedSectionToggle"
                >
                    <Text as="span">Paused ({paused.length})</Text>
                    {isPausedSectionOpen ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                </button>
                {/* Not kept mounted: collapsed rows would stay in the DOM with data-list-item-id
                    anchors that skew scroll restoration. */}
                <Collapsible open={isPausedSectionOpen} keepMounted={false}>
                    <ul className={styles.list}>
                        {paused.map((routine, idx) => (
                            <li key={routine._id} className={styles.pausedRow} data-list-item-id={routine._id}>
                                {renderRoutineRow(routine, idx < paused.length - 1)}
                            </li>
                        ))}
                    </ul>
                </Collapsible>
            </div>
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
                    // collection doesn't block the main thread on navigation.
                    <div className={styles.list}>
                        <WindowVirtualizer>
                            {buckets.flatMap((group) => [
                                <Text
                                    key={`bucket-${group.bucket}`}
                                    as="div"
                                    variant="overline"
                                    tone="secondary"
                                    className={styles.bucketLabel}
                                    data-testid="routineFrequencyBucket"
                                >
                                    {group.bucket}
                                </Text>,
                                ...group.routines.map((routine, idx) => (
                                    // data-list-item-id: scroll-restoration anchor (see useListScrollRestoration)
                                    <div key={routine._id} data-list-item-id={routine._id}>
                                        {renderRoutineRow(routine, idx < group.routines.length - 1)}
                                    </div>
                                )),
                            ])}
                        </WindowVirtualizer>
                    </div>
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
        <div>
            <ListPageHeader
                title="Routines"
                count={routines.length}
                action={
                    <Tooltip title="Create routine">
                        <IconButton aria-label="Create routine" onClick={(e) => editor.openEditor({ event: e })} data-testid="newRoutineButton">
                            <Plus />
                        </IconButton>
                    </Tooltip>
                }
            >
                {/* Routines surface GCal-linked recurring series, so a calendar sync can change them. */}
                {isCalendarSyncing && <SyncingChip label="Syncing calendar…" />}
                <AccountSyncChip />
            </ListPageHeader>
            {hasAnyRoutines && (
                <TextField
                    size="sm"
                    fullWidth
                    placeholder="Search routines…"
                    value={search.queryInput}
                    onChange={(e) => search.setQueryInput(e.target.value)}
                    className={styles.searchField}
                    inputRef={searchFieldRef}
                    inputProps={{ 'aria-label': 'Search routines', 'data-testid': 'routinesSearchInput' }}
                />
            )}
            {hasAnyRoutines && (
                <div className={styles.controlsRow}>
                    <Tabs
                        aria-label="Routine type"
                        value={activeTab}
                        onValueChange={onTabSelected}
                        tabs={[
                            { value: 'nextAction', label: `Next Action (${nextActionCount})`, 'data-testid': 'routinesTabNextAction' },
                            { value: 'calendar', label: `Calendar (${calendarCount})`, 'data-testid': 'routinesTabCalendar' },
                        ]}
                    />
                    <ToggleGroup size="sm" aria-label="Routines view" value={activeView} onValueChange={onViewSelected} options={VIEW_OPTIONS} />
                </div>
            )}
            {isBootstrapping ? <ListSkeleton /> : activeView === 'week' ? renderWeekView() : renderListView()}
            <AlertDialog open={routineToDelete !== null} onClose={() => setRoutineToDelete(null)} size="sm" fullWidth data-testid="deleteRoutineDialog">
                <DialogTitle>Delete routine?</DialogTitle>
                <DialogDescription>
                    {routineToDelete ? <>Delete "{routineToDelete.title}"?</> : null}
                    {routineToDelete?.routineType === 'calendar' && (
                        <>
                            <br />
                            <br />
                            This will also remove the recurring event from Google Calendar and trash all generated calendar items.
                        </>
                    )}
                </DialogDescription>
                <DialogActions>
                    <Button onClick={() => setRoutineToDelete(null)}>Cancel</Button>
                    <Button variant="solid" tone="danger" onClick={() => void onConfirmDelete()} data-testid="deleteRoutineConfirm">
                        Delete
                    </Button>
                </DialogActions>
            </AlertDialog>
            <PauseRoutineConfirmDialog routine={routineToPause} onCancel={() => setRoutineToPause(null)} onConfirm={() => void onConfirmPause()} />
        </div>
    );
}
