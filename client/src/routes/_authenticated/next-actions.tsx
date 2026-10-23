import BoltIcon from '@mui/icons-material/Bolt';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import EditIcon from '@mui/icons-material/Edit';
import KeyboardIcon from '@mui/icons-material/KeyboardOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import PersonOutlineIcon from '@mui/icons-material/PersonOutlined';
import SellOutlinedIcon from '@mui/icons-material/SellOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import { useTheme } from '@mui/material/styles';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import classNames from 'classnames';
import dayjs from 'dayjs';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { WindowVirtualizer, type WindowVirtualizerHandle } from 'virtua';
import { AccountChip } from '../../components/AccountChip';
import { AccountSyncChip } from '../../components/AccountSyncChip';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { useItemEditor } from '../../components/itemEditor/useItemEditor';
import { ListRowShell } from '../../components/ListRowShell';
import { ListSearchButton, ListSearchField } from '../../components/ListSearch';
import { ListSkeleton } from '../../components/ListSkeleton';
import { MoveToSheet } from '../../components/nextActions/MoveToSheet';
import { ReorderShortcutsDialog } from '../../components/nextActions/ReorderShortcutsDialog';
import { CollapsibleChipGroup } from '../../components/pickers/CollapsibleChipGroup';
import { RoutineIndicator } from '../../components/RoutineIndicator';
import { useAppData } from '../../contexts/AppDataProvider';
import { clarifyToDone, reorderItem } from '../../db/itemMutations';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useEntityUsage } from '../../hooks/useEntityUsage';
import { useListGhosts } from '../../hooks/useListGhosts';
import { useListScrollRestoration } from '../../hooks/useListScrollRestoration';
import { useListSearch } from '../../hooks/useListSearch';
import { type ReorderCommit, useNextActionsDrag } from '../../hooks/useNextActionsDrag';
import { type RowCommand, useNextActionsRovingFocus } from '../../hooks/useNextActionsRovingFocus';
import { useTodayIso } from '../../hooks/useTodayIso';
import { compareNextActions } from '../../lib/compareNextActions';
import { getTodayIso } from '../../lib/dayClock';
import { grabPreviewOrder } from '../../lib/dragReorder';
import { omitArchived, rankMergedOptionsByUsage } from '../../lib/entityUsage';
import { filterItemsByQuery, itemContextTags, itemPersonRefIds, itemPersonTags, type ResolvedTag } from '../../lib/itemSearch';
import { isGhostOf } from '../../lib/listGhosts';
import {
    filterOptionsToReferenced,
    type MergedFilterOption,
    mergeFilterOptionsByName,
    resolveSelectedFilterOption,
    type SelectedFilterOption,
    sameNameIds,
} from '../../lib/mergedFilterOptions';
import { missingClarifications } from '../../lib/missingClarifications';
import { flatIndexOfItem, flattenSections, groupIntoSections, type NextActionSection } from '../../lib/nextActionSections';
import { isFocusFree, ROW_BUTTON_ATTR, ROW_HANDLE_ATTR, ROW_ITEM_ATTR, ROW_SECTION_ATTR, rowElement } from '../../lib/nextActionsRowDom';
import { type NextActionsUrlState, parseNextActionsSearch, TIME_FILTER_OPTIONS } from '../../lib/nextActionsUrlParams';
import { chordLabel, isApplePlatform } from '../../lib/platformKeys';
import { isTicklerHidden } from '../../lib/ticklerVisibility';
import { hasAtLeastOne, type NonEmptyArray } from '../../lib/typeUtils';
import type { EnergyLevel, StoredItem, StoredPerson, StoredWorkContext } from '../../types/MyDB';
import styles from './-next-actions.module.css';

export const Route = createFileRoute('/_authenticated/next-actions')({
    validateSearch: parseNextActionsSearch,
    component: NextActionsPage,
});

const energyLabels: Record<EnergyLevel, string> = { low: 'Low', medium: 'Medium', high: 'High' };
const energyColors: Record<EnergyLevel, 'default' | 'success' | 'warning' | 'error'> = {
    low: 'success',
    medium: 'warning',
    high: 'error',
};

/** Match context for the row filters: same-name id groups the context/person URL filters expand
 *  to in the merged multi-account view (see mergeFilterOptionsByName; absent groups fall back to
 *  exact single-id matching), plus the day the tickler boundary is judged against. */
export interface FilterIdGroups {
    contextIds?: ReadonlySet<string> | undefined;
    personIds?: ReadonlySet<string> | undefined;
    /** Local calendar date for the ignoreBefore cutoff. Callers inside memoized render paths must
     *  pass the `useTodayIso()` value (and depend on it) so the filter rolls at local midnight
     *  instead of caching yesterday's day. Defaults to the shared day clock's snapshot. */
    todayIso?: string | undefined;
}

export function matchesFilters(item: StoredItem, filters: NextActionsUrlState, groups: FilterIdGroups = {}): boolean {
    const today = groups.todayIso ?? getTodayIso();
    if (isTicklerHidden(item, today)) {
        return false;
    }
    if (filters.energy && item.energy !== filters.energy) {
        return false;
    }
    if (filters.time && (item.time === undefined || item.time > filters.time)) {
        return false;
    }
    if (filters.context) {
        const { contextIds } = groups;
        const matched = contextIds ? item.workContextIds?.some((id) => contextIds.has(id)) : item.workContextIds?.includes(filters.context);
        if (!matched) {
            return false;
        }
    }
    if (filters.person) {
        const { personIds } = groups;
        // itemPersonRefIds (peopleIds + waitingForPersonId) keeps this in lockstep with the tag
        // chips, usage ranking, and the facet pools — a chip must never appear that matches nothing.
        const refIds = itemPersonRefIds(item);
        const matched = personIds ? refIds.some((id) => personIds.has(id)) : refIds.includes(filters.person);
        if (!matched) {
            return false;
        }
    }
    return true;
}

interface MergedFilterChipRowProps {
    /** Live options A→Z — the expanded view's order. */
    options: MergedFilterOption[];
    /** The same options usage-ranked — the collapsed view's order. */
    rankedOptions: MergedFilterOption[];
    /** The resolved active selection for this row — undefined when the row's filter is unset. */
    selected: SelectedFilterOption | undefined;
    onToggle: (option: MergedFilterOption) => void;
    activeColor: 'primary' | 'info';
    icon?: React.ReactElement;
    testId: string;
}

// One row of merged filter chips (contexts or people). Active state comes from the resolved
// selection — the same source matchesFilters uses — so an applied filter always lights its chip,
// even when the URL holds a hidden account's twin id. Long rows collapse to the most-used chips
// behind a "+N more" expander (see CollapsibleChipGroup).
function MergedFilterChipRow({ options, rankedOptions, selected, onToggle, activeColor, icon, testId }: MergedFilterChipRowProps) {
    if (options.length === 0) {
        return null;
    }
    const selectedIds = selected?.option ? new Set([selected.option.canonicalId]) : new Set<string>();
    return (
        <CollapsibleChipGroup
            ranked={rankedOptions}
            alphabetical={options}
            selectedIds={selectedIds}
            keyOf={(option) => option.canonicalId}
            testId={testId}
            sx={{ mb: 1 }}
            renderChip={(option) => {
                const isActive = option.canonicalId === selected?.option?.canonicalId;
                return (
                    <Chip
                        {...(icon ? { icon } : {})}
                        label={option.name}
                        size="small"
                        variant={isActive ? 'filled' : 'outlined'}
                        color={isActive ? activeColor : 'default'}
                        onClick={() => onToggle(option)}
                        data-testid={testId}
                    />
                );
            }}
        />
    );
}

// Amber hint that the clarify phase was left incomplete; the tooltip names only the actually-missing fields.
export function UnclarifiedWarning({ missingLabels }: { missingLabels: NonEmptyArray<string> }) {
    return (
        <Tooltip title={`Not fully clarified — missing: ${missingLabels.join(', ')}`}>
            <WarningAmberIcon fontSize="small" color="warning" data-testid="unclarifiedWarning" />
        </Tooltip>
    );
}

// "Show tags" preference persists across visits. Defaults ON; only an explicit 'false' hides them.
const SHOW_TAGS_KEY = 'nextActions.showTags';
export const readShowTags = () => localStorage.getItem(SHOW_TAGS_KEY) !== 'false';

interface RowTagsProps {
    contextTags: ResolvedTag[];
    personTags: ResolvedTag[];
    dueLabel: string | null;
}

// Second line of a next-action row: work-context chips (tag icon), people chips (person icon),
// then the optional "Due" text. Chips keyed by entity id — display names are not unique.
export function RowTags({ contextTags, personTags, dueLabel }: RowTagsProps) {
    if (contextTags.length === 0 && personTags.length === 0 && !dueLabel) {
        return null;
    }
    return (
        <Box component="span" className={styles.tagRow} data-testid="nextActionRowTags">
            {contextTags.map((tag) => (
                <Chip
                    key={`ctx-${tag.id}`}
                    icon={<SellOutlinedIcon />}
                    label={tag.name}
                    size="small"
                    variant="outlined"
                    className={tag.archived ? styles.archivedTag : undefined}
                />
            ))}
            {personTags.map((tag) => (
                <Chip
                    key={`person-${tag.id}`}
                    icon={<PersonOutlineIcon />}
                    label={tag.name}
                    size="small"
                    color="info"
                    variant="outlined"
                    className={tag.archived ? styles.archivedTag : undefined}
                />
            ))}
            {dueLabel && (
                <Typography component="span" variant="caption" color="text.secondary" className={styles.dueText}>
                    {dueLabel}
                </Typography>
            )}
        </Box>
    );
}

interface RowSecondaryDeps {
    showTags: boolean;
    contextsById: Map<string, StoredWorkContext>;
    peopleById: Map<string, StoredPerson>;
}

// Builds a row's second line. Tags hidden → just the "Due" text (original behaviour, undefined when no date);
// tags shown → work-context + people chips precede it. Extracted so both branches are unit-testable.
export function buildRowSecondary(item: StoredItem, { showTags, contextsById, peopleById }: RowSecondaryDeps) {
    const dueLabel = item.expectedBy ? `Due ${dayjs(item.expectedBy).format('MMM D')}` : null;
    if (!showTags) {
        return dueLabel ?? undefined;
    }
    return <RowTags contextTags={itemContextTags(item, contextsById)} personTags={itemPersonTags(item, peopleById)} dueLabel={dueLabel} />;
}

/**
 * ONE predicate for the touch UI (always-visible drag handle + the "Move to…" overflow): the same
 * media query the CSS module uses for the handle, so the two can never disagree. Deliberately not
 * `breakpoints.down('md')` — a narrow desktop window has a mouse; a tablet has not.
 */
export const TOUCH_UI_MEDIA_QUERY = '(hover: none) and (pointer: coarse)';

/** A contextmenu raised by a touch long press (Chrome/Android dispatch it as a PointerEvent); a mouse right-click is not. */
function isTouchContextMenu(event: Event): boolean {
    return 'pointerType' in event && event.pointerType === 'touch';
}

/** The rows' (and the handle's) screen-reader description, spelled for the platform (⌥ on a Mac, Alt elsewhere). */
export function reorderHintText(isApple: boolean): string {
    const label = (parts: Parameters<typeof chordLabel>[0]) => chordLabel(parts, isApple);
    return (
        'Arrow Up or Down moves between rows, Home and End to the first and last row, Arrow Right into the row’s buttons. ' +
        'Enter opens the row; E edits, D marks it done, C copies its id, M opens Move to. ' +
        `Press Space to pick the row up, Arrow Up or Down to move it, ${label(['shift', 'up'])} or ${label(['shift', 'down'])} to jump to the top or bottom, ` +
        `Space to drop, Escape to cancel. ${label(['alt', 'up'])} or ${label(['alt', 'down'])} moves the row one slot; ` +
        `${label(['alt', 'shift', 'up'])} or ${label(['alt', 'shift', 'down'])} moves it to the top or bottom of its day.`
    );
}

function NextActionsPage() {
    useDocumentTitle('Next Actions');
    const { db } = Route.useRouteContext();
    const { items, workContexts, people, allWorkContexts, allPeople, routines, refreshItems, isInitialSyncing } = useAppData();
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
    const isApple = useMemo(isApplePlatform, []);
    const virtualizerRef = useRef<WindowVirtualizerHandle>(null);
    const dragHintId = useId();
    const rowHintId = useId();
    // Stored by id so the sheet always commits against the LIVE section (a pull can change it while the sheet is open).
    const [moveTarget, setMoveTarget] = useState<{ itemId: string; sectionKey: string } | null>(null);
    const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
    const editor = useItemEditor({ db, people, workContexts, refreshItems, isMobile });
    const urlFilters = Route.useSearch();
    const navigate = useNavigate();
    const [showTags, setShowTags] = useState(readShowTags);
    useListScrollRestoration();
    const { itemsWithGhosts, isGhost, onGhostExited } = useListGhosts(items);

    // Filters live in the URL so views are shareable/bookmarkable. Clicking the active chip again
    // clears it (single-select toggle); replace: true so chip toggling doesn't spam history.
    function toggleFilter<K extends keyof NextActionsUrlState>(key: K, value: NextActionsUrlState[K]) {
        const next = urlFilters[key] === value ? undefined : value;
        void navigate({ to: '/next-actions', search: { ...urlFilters, [key]: next }, replace: true });
    }

    // Group-aware toggle for merged chips: clicking the active chip must clear the filter even
    // when the URL holds a non-canonical twin id (deep link minted from the other account).
    function toggleMergedFilter(key: 'context' | 'person', option: MergedFilterOption) {
        const selected = key === 'context' ? selectedContext : selectedPerson;
        const isActive = option.canonicalId === selected?.option?.canonicalId;
        void navigate({ to: '/next-actions', search: { ...urlFilters, [key]: isActive ? undefined : option.canonicalId }, replace: true });
    }

    const writeUrlQuery = useCallback(
        (query: string) => void navigate({ to: '/next-actions', search: { ...urlFilters, q: query || undefined }, replace: true }),
        [navigate, urlFilters],
    );
    const search = useListSearch({ urlQuery: urlFilters.q ?? '', writeUrlQuery });

    function onShowTagsToggled(next: boolean) {
        setShowTags(next);
        localStorage.setItem(SHOW_TAGS_KEY, String(next));
    }

    // Lookup maps for resolving an item's workContextIds / peopleIds to names without rescanning the arrays per row.
    // Built from the unfiltered all* sets: a visible item may reference a hidden account's entity
    // (cross-account references exist), and its chip must still resolve to a name.
    const contextsById = useMemo(() => new Map(allWorkContexts.map((c) => [c._id, c])), [allWorkContexts]);
    const peopleById = useMemo(() => new Map(allPeople.map((p) => [p._id, p])), [allPeople]);
    const routineTitleById = useMemo(() => new Map(routines.map((r) => [r._id, r.title])), [routines]);

    // Filter chips: same-named contexts/people across signed-in accounts collapse into one chip
    // (each account owns its own "agenda"/"computer" — duplicates are UX noise). Sorted A→Z by the
    // merge helper; AppDataProvider keeps stored order for other pages. Archived entities are cut
    // first — except the URL-selected id's whole same-name twin group, so the selection stays
    // clickable AND keeps matching items tagged with an archived twin.
    const activeContexts = useMemo(
        () => omitArchived(workContexts, sameNameIds(urlFilters.context, allWorkContexts)),
        [workContexts, urlFilters.context, allWorkContexts],
    );
    const activePeople = useMemo(() => omitArchived(people, sameNameIds(urlFilters.person, allPeople)), [people, urlFilters.person, allPeople]);
    const mergedContextOptions = useMemo(() => mergeFilterOptionsByName(activeContexts), [activeContexts]);
    const mergedPersonOptions = useMemo(() => mergeFilterOptionsByName(activePeople), [activePeople]);
    // The URL stores one id; the resolver expands it to the whole same-name group (via the
    // unfiltered all* sets, so a hidden account's twin id still re-attaches to the visible chip)
    // and names the active chip. Chips and matchesFilters share this — they can never disagree.
    const selectedContext = useMemo(
        () => resolveSelectedFilterOption(urlFilters.context, mergedContextOptions, allWorkContexts),
        [urlFilters.context, mergedContextOptions, allWorkContexts],
    );
    const selectedPerson = useMemo(
        () => resolveSelectedFilterOption(urlFilters.person, mergedPersonOptions, allPeople),
        [urlFilters.person, mergedPersonOptions, allPeople],
    );
    // Subscribes to the shared day clock — the memoized filter passes below roll at local midnight.
    const todayIso = useTodayIso();
    const filterGroups = useMemo<FilterIdGroups>(
        () => ({ contextIds: selectedContext?.ids, personIds: selectedPerson?.ids, todayIso }),
        [selectedContext, selectedPerson, todayIso],
    );

    // Deferred query: typing re-filters in an interruptible background render (see useListSearch).
    const { deferredQuery } = search;
    const visibleNextActions = useMemo(() => itemsWithGhosts.filter((item) => item.status === 'nextAction'), [itemsWithGhosts]);
    const nextActions = useMemo(() => {
        const visible = visibleNextActions.filter((item) => matchesFilters(item, urlFilters, filterGroups));
        return [...filterItemsByQuery(visible, deferredQuery)].sort(compareNextActions);
    }, [visibleNextActions, urlFilters, filterGroups, deferredQuery]);
    // One section per expected day (+ "No date"); headers roll at local midnight via todayIso.
    const sections = useMemo(() => groupIntoSections(nextActions, todayIso), [nextActions, todayIso]);

    // Facet-style live options: each row offers only chips that still match at least one row under
    // all the OTHER filters (a zero-result chip is noise; its own filter is excluded so switching
    // between sibling values stays possible). The selected option is exempt inside
    // filterOptionsToReferenced. Rows are collapsed to the most-used chips by MergedFilterChipRow.
    const usage = useEntityUsage();
    const referencedContextIds = useMemo(() => {
        const pool = visibleNextActions.filter((item) =>
            matchesFilters(item, { ...urlFilters, context: undefined }, { personIds: selectedPerson?.ids, todayIso }),
        );
        return new Set(filterItemsByQuery(pool, deferredQuery).flatMap((item) => item.workContextIds ?? []));
    }, [visibleNextActions, urlFilters, selectedPerson, deferredQuery, todayIso]);
    const referencedPersonIds = useMemo(() => {
        const pool = visibleNextActions.filter((item) =>
            matchesFilters(item, { ...urlFilters, person: undefined }, { contextIds: selectedContext?.ids, todayIso }),
        );
        return new Set(filterItemsByQuery(pool, deferredQuery).flatMap(itemPersonRefIds));
    }, [visibleNextActions, urlFilters, selectedContext, deferredQuery, todayIso]);
    const liveContextOptions = useMemo(
        () => filterOptionsToReferenced(mergedContextOptions, referencedContextIds, selectedContext?.option),
        [mergedContextOptions, referencedContextIds, selectedContext],
    );
    const livePersonOptions = useMemo(
        () => filterOptionsToReferenced(mergedPersonOptions, referencedPersonIds, selectedPerson?.option),
        [mergedPersonOptions, referencedPersonIds, selectedPerson],
    );
    const rankedContextOptions = useMemo(() => rankMergedOptionsByUsage(liveContextOptions, usage.contexts), [liveContextOptions, usage.contexts]);
    const rankedPersonOptions = useMemo(() => rankMergedOptionsByUsage(livePersonOptions, usage.people), [livePersonOptions, usage.people]);

    // Rows whose Done is mid-flight. A second D (or click) would run clarifyToDone again from the
    // same stale snapshot — for a routine's item, a second follow-up. The guard must outlive
    // `refreshItems()` (it resolves when the refresh STARTS, not when the row is gone): the ghost
    // store, written synchronously by the mutation, says whether THIS snapshot has already left
    // (matched by snapshot, not by id — a ghost another page recorded must not block a live row).
    const doneInFlight = useRef(new Set<string>());
    async function runDoneOnce(item: StoredItem, markDone: () => Promise<void>) {
        if (doneInFlight.current.has(item._id) || isGhostOf(item)) {
            return;
        }
        doneInFlight.current.add(item._id);
        try {
            await markDone();
        } finally {
            doneInFlight.current.delete(item._id);
        }
    }

    async function onDone(item: StoredItem) {
        const handOff = focusHandOffFrom(item._id);
        await runDoneOnce(item, async () => {
            await clarifyToDone(db, item, { onReadOnlyGCal: editor.onFromGmailReadOnly });
            await refreshItems();
        });
        handOff();
    }

    /**
     * A keyboard user (D, or Enter on the Done button) must not be left on the fading ghost row:
     * captured BEFORE the row leaves, the hand-off moves focus to its neighbour afterwards — unless
     * the user has put focus somewhere else meanwhile (the search field), which is never stolen.
     */
    function focusHandOffFrom(itemId: string): () => void {
        const row = rowElement(itemId);
        const hadFocus = row?.contains(document.activeElement) === true;
        const next = roving.neighbourRowId(itemId);
        return () => {
            const current = rowElement(itemId);
            if (hadFocus && next !== undefined && (!current || isFocusFree(current))) {
                roving.focusRow(next);
            }
        };
    }

    const openMoveTo = useCallback(
        (item: StoredItem, section: NextActionSection<StoredItem>) => setMoveTarget({ itemId: item._id, sectionKey: section.key }),
        [],
    );

    // The one commit every reorder gesture (drag, keyboard, Move to…) runs: the section's LIVE
    // rows (ghosts are fading leftovers — never a neighbour, never re-keyed) as displayed, plus the
    // neighbours by id; `reorderItem` reads the full day section itself. D5: this runs under active
    // filters/search too — the key is minted between the visible neighbours.
    const sectionsRef = useRef(sections);
    useLayoutEffect(() => {
        sectionsRef.current = sections;
    }, [sections]);
    // Every account in the merged view, whether or not any of its rows is visible right now: they
    // share the keyspace, so a re-key must include them.
    const ownerIds = useMemo(() => [...new Set(visibleNextActions.map((row) => row.userId))], [visibleNextActions]);
    const commitReorder = useCallback(
        async ({ sectionKey, itemId, aboveId, belowId }: ReorderCommit) => {
            const section = sectionsRef.current.find((candidate) => candidate.key === sectionKey);
            const live = section?.items.filter((row) => !isGhost(row)) ?? [];
            const moved = await reorderItem(db, { sectionItems: live, itemId, aboveId, belowId, ownerIds });
            if (moved) {
                await refreshItems();
            }
            return moved !== null;
        },
        [db, isGhost, refreshItems, ownerIds],
    );
    // Reads the rendered rows through a ref: they are derived from the drag state this callback feeds.
    const flatRowsRef = useRef<ReturnType<typeof flattenSections<StoredItem>>>([]);
    const scrollRowIntoView = useCallback((itemId: string) => {
        const flatIndex = flatIndexOfItem(flatRowsRef.current, itemId);
        if (flatIndex >= 0) {
            virtualizerRef.current?.scrollToIndex(flatIndex, { align: 'nearest' });
        }
    }, []);
    const drag = useNextActionsDrag({ sections, isGhost, onCommit: commitReorder, scrollRowIntoView });
    // A keyboard grab renders its section in preview order — the grabbed row really moves to its
    // slot (so it stays mounted wherever the slot scrolls to); a pointer drag shifts rows with
    // transforms instead and renders the true order.
    const grabState = drag.previewGrab;
    const renderedSections = useMemo(
        () =>
            grabState
                ? sections.map((section) =>
                      section.key === grabState.sectionKey ? { ...section, items: grabPreviewOrder(section.items, grabState) } : section,
                  )
                : sections,
        [sections, grabState],
    );
    const flatRows = useMemo(() => flattenSections(renderedSections), [renderedSections]);
    useLayoutEffect(() => {
        flatRowsRef.current = flatRows;
    }, [flatRows]);
    const onRowCommand = useCallback(
        (command: RowCommand, item: StoredItem, section: NextActionSection<StoredItem>) => {
            if (command.type === 'grab') {
                drag.grab(item, section);
            } else if (command.type === 'commitNudge') {
                drag.commitStep(item, section, { delta: command.delta });
            } else if (command.type === 'commitJump') {
                drag.commitStep(item, section, { edge: command.edge });
            }
        },
        [drag.grab, drag.commitStep],
    );
    const roving = useNextActionsRovingFocus({ flatRows, isGhost, virtualizerRef, isReorderActive: drag.drag !== null, onRowCommand });
    const moveTargetSection = useMemo(() => sections.find((section) => section.key === moveTarget?.sectionKey), [sections, moveTarget]);
    const moveTargetItem = useMemo(() => moveTargetSection?.items.find((row) => row._id === moveTarget?.itemId) ?? null, [moveTargetSection, moveTarget]);
    const moveTargetLive = useMemo(() => moveTargetSection?.items.filter((row) => !isGhost(row)) ?? [], [moveTargetSection, isGhost]);
    // A target that vanished while the sheet was open (completed elsewhere, pulled away) closes the
    // sheet on its own; forget it too, or an undo bringing the row back would reopen the sheet.
    useEffect(() => {
        if (moveTarget && !moveTargetItem) {
            setMoveTarget(null);
        }
    }, [moveTarget, moveTargetItem]);

    // Ghosts are fading leftovers, not open work — the header count reflects live rows only.
    const liveNextActionCount = nextActions.filter((item) => !isGhost(item)).length;

    return (
        <Box>
            {/* mb on the wrapper (not the Typography) so the chip stays vertically centered with the title. */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                <Typography
                    variant="h5"
                    sx={{
                        fontWeight: 600,
                    }}
                >
                    Next Actions
                    {liveNextActionCount > 0 && <Chip label={liveNextActionCount} size="small" color="primary" className={styles.countChip} />}
                </Typography>
                {/* "Syncing account…" while a newly-added account bootstraps; surfaces even when the list already has items. */}
                <AccountSyncChip />
                <ListSearchButton onToggle={search.toggleSearch} testId="nextActionsSearchButton" />
                <Tooltip title="Keyboard shortcuts">
                    <IconButton size="small" aria-label="Keyboard shortcuts" onClick={() => setIsShortcutsOpen(true)} data-testid="nextActionsShortcutsButton">
                        <KeyboardIcon fontSize="small" />
                    </IconButton>
                </Tooltip>
            </Box>
            {search.isOpen && (
                <ListSearchField
                    value={search.queryInput}
                    onValueChange={search.setQueryInput}
                    onClose={search.closeSearch}
                    placeholder="Search next actions…"
                    testId="nextActionsSearchInput"
                />
            )}
            {/* Filter bar */}
            <Box
                sx={{
                    mb: 2,
                }}
            >
                <MergedFilterChipRow
                    options={liveContextOptions}
                    rankedOptions={rankedContextOptions}
                    selected={selectedContext}
                    onToggle={(option) => toggleMergedFilter('context', option)}
                    activeColor="primary"
                    testId="nextActionsContextFilterChip"
                />
                <MergedFilterChipRow
                    options={livePersonOptions}
                    rankedOptions={rankedPersonOptions}
                    selected={selectedPerson}
                    onToggle={(option) => toggleMergedFilter('person', option)}
                    activeColor="info"
                    icon={<PersonOutlineIcon />}
                    testId="nextActionsPersonFilterChip"
                />
                <Stack
                    direction="row"
                    sx={{
                        flexWrap: 'wrap',
                        gap: 0.75,
                    }}
                >
                    {(['low', 'medium', 'high'] as EnergyLevel[]).map((e) => (
                        <Chip
                            key={e}
                            label={`${energyLabels[e]} energy`}
                            size="small"
                            variant={urlFilters.energy === e ? 'filled' : 'outlined'}
                            color={urlFilters.energy === e ? energyColors[e] : 'default'}
                            onClick={() => toggleFilter('energy', e)}
                            data-testid="nextActionsEnergyFilterChip"
                        />
                    ))}
                    {TIME_FILTER_OPTIONS.map((t) => (
                        <Chip
                            key={t}
                            label={`≤ ${t} min`}
                            size="small"
                            variant={urlFilters.time === t ? 'filled' : 'outlined'}
                            color={urlFilters.time === t ? 'primary' : 'default'}
                            onClick={() => toggleFilter('time', t)}
                            data-testid="nextActionsTimeFilterChip"
                        />
                    ))}
                </Stack>
                <FormControlLabel
                    sx={{ mt: 0.5 }}
                    control={
                        <Switch size="small" checked={showTags} onChange={(e) => onShowTagsToggled(e.target.checked)} data-testid="nextActionsShowTagsToggle" />
                    }
                    label={<Typography variant="body2">Show tags</Typography>}
                />
            </Box>
            {nextActions.length === 0 ? (
                // isInitialSyncing is only true during first-launch bootstrap, when IDB is empty —
                // so an empty result then is "not loaded", not "filtered out". Show the skeleton.
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
                        {/* Distinguish an unmatched search from unmatched filter chips — same convention as inbox/calendar. */}
                        {deferredQuery.trim() ? 'No next actions match your search.' : 'No next actions match the current filters.'}
                    </Typography>
                )
            ) : (
                // component="div": WindowVirtualizer renders a measuring <div> wrapper, invalid inside
                // the default <ul>. Windowed rendering — only rows near the viewport mount, so a large
                // next-actions list doesn't block the main thread on navigation.
                // One tab stop for the whole list (see useNextActionsRovingFocus): the container
                // forwards focus to the remembered row, the rows and their buttons are tabIndex -1.
                <List
                    disablePadding
                    component="div"
                    role="list"
                    className={styles.list}
                    aria-label="Next actions"
                    aria-describedby={dragHintId}
                    data-testid="nextActionsList"
                    {...roving.listProps}
                >
                    <WindowVirtualizer ref={virtualizerRef}>
                        {flatRows.map((row) => {
                            if (row.kind === 'header') {
                                return (
                                    <Typography
                                        key={`header-${row.section.key}`}
                                        component="div"
                                        // subtitle2, not overline: overline's text-transform would shout "TODAY" and
                                        // turn the weekday/month casing into noise.
                                        variant="subtitle2"
                                        className={classNames(styles.sectionHeader, {
                                            [styles.sectionHeaderOverdue]: row.section.isOverdue,
                                            [styles.dimmedSection]: drag.drag !== null && drag.drag.sectionKey !== row.section.key,
                                        })}
                                        data-testid="nextActionSectionHeader"
                                        data-section-key={row.section.key}
                                    >
                                        {row.section.label}
                                    </Typography>
                                );
                            }
                            const { item, section } = row;
                            const missingLabels = missingClarifications(item, hasAtLeastOne(workContexts));
                            const isDragged = drag.drag?.itemId === item._id;
                            const isPointerDragged = isDragged && !drag.drag?.isKeyboard;
                            const isOtherSection = drag.drag !== null && drag.drag.sectionKey !== section.key;
                            const rowIsGhost = isGhost(item);
                            return (
                                <ListRowShell key={item._id} itemId={item._id} isGhost={rowIsGhost} onGhostExited={onGhostExited}>
                                    <ListItem
                                        disablePadding
                                        className={classNames(styles.item, styles.rowShell, {
                                            [styles.dragging]: isDragged,
                                            [styles.shifted]: !isDragged && drag.drag !== null,
                                            [styles.dimmedSection]: isOtherSection,
                                        })}
                                        // The displacement is measured geometry (the dragged row's own height), so it
                                        // travels as a CSS variable the module's `transform` reads — see the CSS note.
                                        // The dragged row itself is moved imperatively by the hook (every frame), so React
                                        // leaves its variable alone. The literal is `DRAG_SHIFT_VAR` (typed through
                                        // `types/cssCustomProperties.d.ts`); keep the two in step.
                                        style={isPointerDragged ? undefined : { '--drag-shift': `${drag.shiftFor(item._id)}px` }}
                                        {...{ [ROW_SECTION_ATTR]: section.key, [ROW_ITEM_ATTR]: item._id }}
                                        secondaryAction={
                                            <Box className={styles.actionButtons}>
                                                {/* A ghost is a stale snapshot of a row that already left the list: only its id may still be copied. */}
                                                {!rowIsGhost && (
                                                    <Tooltip title="Move to…">
                                                        <IconButton
                                                            size="small"
                                                            onClick={() => openMoveTo(item, section)}
                                                            data-testid="nextActionMoveToButton"
                                                            {...roving.actionButtonProps('moveTo')}
                                                        >
                                                            <MoreVertIcon fontSize="small" />
                                                        </IconButton>
                                                    </Tooltip>
                                                )}
                                                <CopyIdButton
                                                    id={item._id}
                                                    testId="nextActionItemCopyIdButton"
                                                    buttonProps={roving.actionButtonProps('copyId')}
                                                />
                                                {!rowIsGhost && (
                                                    <Tooltip title="Edit">
                                                        <IconButton
                                                            size="small"
                                                            onClick={(e) => editor.openEditor({ item, event: e })}
                                                            data-testid="nextActionItemEditButton"
                                                            {...roving.actionButtonProps('edit')}
                                                        >
                                                            <EditIcon fontSize="small" />
                                                        </IconButton>
                                                    </Tooltip>
                                                )}
                                                {!rowIsGhost && (
                                                    <Tooltip title="Mark done">
                                                        <IconButton
                                                            size="small"
                                                            color="success"
                                                            onClick={() => void onDone(item)}
                                                            data-testid="nextActionItemDoneButton"
                                                            {...roving.actionButtonProps('done')}
                                                        >
                                                            <CheckCircleOutlineIcon />
                                                        </IconButton>
                                                    </Tooltip>
                                                )}
                                            </Box>
                                        }
                                    >
                                        {/* A real button beside (not inside) the row button — nested interactive content is
                                            invalid ARIA, and the row's ripple/click would fire on every drop. A ghost (a row
                                            fading out of this list) gets none: it is not a valid drag source. */}
                                        {!rowIsGhost && (
                                            <IconButton
                                                size="small"
                                                className={styles.dragHandle}
                                                aria-label="Reorder"
                                                aria-describedby={dragHintId}
                                                data-testid="nextActionDragHandle"
                                                // Out of the tab order (Space on the row grabs too); still focusable by click.
                                                tabIndex={-1}
                                                {...{ [ROW_HANDLE_ATTR]: '' }}
                                                {...drag.getHandleProps(item, section)}
                                                // Right-click on the handle is the mouse way to the "Move to…" sheet. A touch
                                                // long press already drags (and fires contextmenu mid-press), so the gesture is
                                                // told apart by its pointer type, not by the device: a touch laptop has both.
                                                onContextMenu={(e) => {
                                                    e.preventDefault();
                                                    if (!isTouchContextMenu(e.nativeEvent)) {
                                                        openMoveTo(item, section);
                                                    }
                                                }}
                                            >
                                                <DragIndicatorIcon fontSize="small" />
                                            </IconButton>
                                        )}
                                        <ListItemButton
                                            onClick={(e) => editor.openEditor({ item, event: e })}
                                            className={styles.rowButton}
                                            data-testid="nextActionItemRow"
                                            // Short, per row (screen readers re-read it on every row focus); the full key list sits on the list and the handle.
                                            aria-describedby={rowHintId}
                                            {...{ [ROW_BUTTON_ATTR]: '' }}
                                            {...roving.rowButtonProps}
                                        >
                                            <ListItemText
                                                primary={
                                                    <Box className={styles.titleRow}>
                                                        {item.urgent && <BoltIcon fontSize="small" color="error" />}
                                                        <span>{item.title}</span>
                                                        {item.energy && (
                                                            <Chip label={energyLabels[item.energy]} size="small" color={energyColors[item.energy]} />
                                                        )}
                                                        {item.time !== undefined && <Chip label={`${item.time} min`} size="small" variant="outlined" />}
                                                        {hasAtLeastOne(missingLabels) && <UnclarifiedWarning missingLabels={missingLabels} />}
                                                        {item.routineId && (
                                                            <RoutineIndicator routineId={item.routineId} routineTitle={routineTitleById.get(item.routineId)} />
                                                        )}
                                                        <AccountChip userId={item.userId} />
                                                    </Box>
                                                }
                                                // secondary slot rendered as 'div' so chips (block content) can nest — the default <p> would be invalid DOM.
                                                slotProps={{ secondary: { component: 'div' } }}
                                                secondary={buildRowSecondary(item, { showTags, contextsById, peopleById })}
                                                className={styles.listItemText}
                                            />
                                        </ListItemButton>
                                    </ListItem>
                                    {editor.renderExpandFor(item._id)}
                                    {!row.isLastInSection && <Divider />}
                                </ListRowShell>
                            );
                        })}
                    </WindowVirtualizer>
                </List>
            )}
            {/* Keyboard affordances for the reorder handle (D6) + the polite announcer for every reorder outcome. */}
            <span id={dragHintId} className={styles.srOnly}>
                {reorderHintText(isApple)}
            </span>
            <span id={rowHintId} className={styles.srOnly}>
                Space to reorder, Arrow Right for the row’s buttons.
            </span>
            <ReorderShortcutsDialog open={isShortcutsOpen} onClose={() => setIsShortcutsOpen(false)} isApple={isApple} />
            <div aria-live="polite" className={styles.srOnly} data-testid="nextActionsReorderLive">
                {drag.liveText}
            </div>
            <Snackbar open={drag.error !== null} autoHideDuration={4000} onClose={drag.clearError} message={drag.error ?? ''} />
            {/* Keyed by the target so a vanished row (the Drawer closes on its own) cannot leak its step/search into the next open. */}
            <MoveToSheet
                key={moveTarget?.itemId ?? 'closed'}
                item={moveTargetItem}
                sectionItems={moveTargetLive}
                sectionLabel={moveTargetSection?.label ?? ''}
                onClose={() => setMoveTarget(null)}
                onMove={(neighbours) => {
                    if (moveTarget) {
                        drag.commit({ sectionKey: moveTarget.sectionKey, itemId: moveTarget.itemId, ...neighbours });
                    }
                }}
            />
            {editor.renderGlobal()}
            <Snackbar open={editor.instantToast.open} autoHideDuration={3000} onClose={editor.closeInstantToast} message={editor.instantToast.message} />
        </Box>
    );
}
