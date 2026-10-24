import { createFileRoute, useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { CircleCheck, EllipsisVertical, Pencil, Tag, TriangleAlert, UserRound, Zap } from 'lucide-react';
import { type ReactElement, useCallback, useMemo, useRef, useState } from 'react';
import { WindowVirtualizer } from 'virtua';
import { AccountChip } from '../../components/AccountChip';
import { AccountSyncChip } from '../../components/AccountSyncChip';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { useItemEditor } from '../../components/itemEditor/useItemEditor';
import { ListRowShell } from '../../components/ListRowShell';
import { ListSearchButton, ListSearchField } from '../../components/ListSearch';
import { ListSkeleton } from '../../components/ListSkeleton';
import { ListRow, ListRowButton, ListRowText } from '../../components/listRow/ListRow';
import { CollapsibleChipGroup } from '../../components/pickers/CollapsibleChipGroup';
import { RoutineIndicator } from '../../components/RoutineIndicator';
import { RowActionButton } from '../../components/RowActionButton';
import { RankedListChrome } from '../../components/rankedList/RankedListChrome';
import { RankedRowHandle } from '../../components/rankedList/RankedRowHandle';
import { rankedHeaderClassName, rankedRowButtonProps, rankedRowProps } from '../../components/rankedList/rankedRowProps';
import { useAppData } from '../../contexts/AppDataProvider';
import { clarifyToDone } from '../../db/itemMutations';
import { Chip, type ChipTone, Switch, Text, Toast, Tooltip } from '../../designSystem';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useEntityUsage } from '../../hooks/useEntityUsage';
import { useListGhosts } from '../../hooks/useListGhosts';
import { useListScrollRestoration } from '../../hooks/useListScrollRestoration';
import { useListSearch } from '../../hooks/useListSearch';
import { useRankedList } from '../../hooks/useRankedList';
import { type RovingRegionApi, useRovingRegion } from '../../hooks/useRovingRegion';
import { useTodayIso } from '../../hooks/useTodayIso';
import { compareNextActions } from '../../lib/compareNextActions';
import { getTodayIso } from '../../lib/dayClock';
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
import { groupIntoSections } from '../../lib/nextActionSections';
import { NEXT_ACTIONS_ROW_ACTIONS } from '../../lib/nextActionsKeys';
import { type NextActionsUrlState, parseNextActionsSearch, TIME_FILTER_OPTIONS } from '../../lib/nextActionsUrlParams';
import { isTicklerHidden } from '../../lib/ticklerVisibility';
import { hasAtLeastOne, type NonEmptyArray } from '../../lib/typeUtils';
import type { EnergyLevel, StoredItem, StoredPerson, StoredWorkContext } from '../../types/MyDB';
import styles from './-next-actions.module.css';

export const Route = createFileRoute('/_authenticated/next-actions')({
    validateSearch: parseNextActionsSearch,
    component: NextActionsPage,
});

const energyLabels: Record<EnergyLevel, string> = { low: 'Low', medium: 'Medium', high: 'High' };
const energyTones: Record<EnergyLevel, ChipTone> = {
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
    activeTone: ChipTone;
    icon?: ReactElement | undefined;
    testId: string;
    /** The filter bar's keyboard-region item props (out of the tab order, walked by arrows). */
    itemProps: RovingRegionApi['itemProps'];
}

// One row of merged filter chips (contexts or people). Active state comes from the resolved
// selection — the same source matchesFilters uses — so an applied filter always lights its chip,
// even when the URL holds a hidden account's twin id. Long rows collapse to the most-used chips
// behind a "+N more" expander (see CollapsibleChipGroup).
function MergedFilterChipRow({ options, rankedOptions, selected, onToggle, activeTone, icon, testId, itemProps }: MergedFilterChipRowProps) {
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
            className={styles.filterChipRow}
            expanderChipProps={itemProps}
            renderChip={(option) => {
                const isActive = option.canonicalId === selected?.option?.canonicalId;
                return (
                    <Chip
                        icon={icon}
                        label={option.name}
                        variant="outline"
                        tone={isActive ? activeTone : 'neutral'}
                        selected={isActive}
                        onClick={() => onToggle(option)}
                        data-testid={testId}
                        {...itemProps}
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
            <TriangleAlert size={20} className={styles.warningIcon} data-testid="unclarifiedWarning" />
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
        <span className={styles.tagRow} data-testid="nextActionRowTags">
            {contextTags.map((tag) => (
                <Chip key={`ctx-${tag.id}`} icon={<Tag />} label={tag.name} variant="outline" className={tag.archived ? styles.archivedTag : undefined} />
            ))}
            {personTags.map((tag) => (
                <Chip
                    key={`person-${tag.id}`}
                    icon={<UserRound />}
                    label={tag.name}
                    tone="info"
                    variant="outline"
                    className={tag.archived ? styles.archivedTag : undefined}
                />
            ))}
            {dueLabel && (
                <Text as="span" variant="caption" tone="secondary" className={styles.dueText}>
                    {dueLabel}
                </Text>
            )}
        </span>
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

function NextActionsPage() {
    useDocumentTitle('Next Actions');
    const { db } = Route.useRouteContext();
    const { items, workContexts, people, allWorkContexts, allPeople, routines, refreshItems, isInitialSyncing } = useAppData();
    // The filter bar is one keyboard region: Tab lands on it once, arrows walk the chips and the switch.
    const filterRegion = useRovingRegion({ orientation: 'both', label: 'Filters' });
    const editor = useItemEditor();
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

    // Every account in the merged view, whether or not any of its rows is visible right now: they
    // share the keyspace, so a re-key must include them.
    const ownerIds = useMemo(() => [...new Set(visibleNextActions.map((row) => row.userId))], [visibleNextActions]);
    // The drag, keyboard grab, roving focus and Move to sheet (shared with every list that has a manual order).
    const ranked = useRankedList({ db, sections, isGhost, ownerIds, refreshItems, regionLabel: 'Next actions' });
    const { roving, flatRows, virtualizerRef, openMoveTo, focusHandOffFrom } = ranked;

    // Ghosts are fading leftovers, not open work — the header count reflects live rows only.
    const liveNextActionCount = nextActions.filter((item) => !isGhost(item)).length;

    return (
        <div>
            <div className={styles.header}>
                <Text variant="title">
                    Next Actions
                    {liveNextActionCount > 0 && <Chip label={liveNextActionCount} tone="accent" className={styles.countChip} />}
                </Text>
                {/* "Syncing account…" while a newly-added account bootstraps; surfaces even when the list already has items. */}
                <AccountSyncChip />
                <ListSearchButton onToggle={search.toggleSearch} testId="nextActionsSearchButton" />
            </div>
            {search.isOpen && (
                <ListSearchField
                    value={search.queryInput}
                    onValueChange={search.setQueryInput}
                    onClose={search.closeSearch}
                    placeholder="Search next actions…"
                    testId="nextActionsSearchInput"
                />
            )}
            {/* Filter bar — one keyboard region (role="toolbar": arrows walk it, Tab leaves it). */}
            <div role="toolbar" className={styles.filterBar} {...filterRegion.regionProps}>
                <MergedFilterChipRow
                    options={liveContextOptions}
                    rankedOptions={rankedContextOptions}
                    selected={selectedContext}
                    onToggle={(option) => toggleMergedFilter('context', option)}
                    activeTone="accent"
                    testId="nextActionsContextFilterChip"
                    itemProps={filterRegion.itemProps}
                />
                <MergedFilterChipRow
                    options={livePersonOptions}
                    rankedOptions={rankedPersonOptions}
                    selected={selectedPerson}
                    onToggle={(option) => toggleMergedFilter('person', option)}
                    activeTone="info"
                    icon={<UserRound />}
                    testId="nextActionsPersonFilterChip"
                    itemProps={filterRegion.itemProps}
                />
                <div className={styles.facetChips}>
                    {(['low', 'medium', 'high'] as EnergyLevel[]).map((e) => (
                        <Chip
                            key={e}
                            label={`${energyLabels[e]} energy`}
                            variant="outline"
                            tone={urlFilters.energy === e ? energyTones[e] : 'neutral'}
                            selected={urlFilters.energy === e}
                            onClick={() => toggleFilter('energy', e)}
                            data-testid="nextActionsEnergyFilterChip"
                            {...filterRegion.itemProps}
                        />
                    ))}
                    {TIME_FILTER_OPTIONS.map((t) => (
                        <Chip
                            key={t}
                            label={`≤ ${t} min`}
                            variant="outline"
                            selected={urlFilters.time === t}
                            onClick={() => toggleFilter('time', t)}
                            data-testid="nextActionsTimeFilterChip"
                            {...filterRegion.itemProps}
                        />
                    ))}
                </div>
                <Switch
                    checked={showTags}
                    onCheckedChange={onShowTagsToggled}
                    label="Show tags"
                    className={styles.showTags}
                    data-testid="nextActionsShowTagsToggle"
                    controlProps={filterRegion.itemProps}
                />
            </div>
            {nextActions.length === 0 ? (
                // isInitialSyncing is only true during first-launch bootstrap, when IDB is empty —
                // so an empty result then is "not loaded", not "filtered out". Show the skeleton.
                isInitialSyncing ? (
                    <ListSkeleton />
                ) : (
                    <Text tone="secondary" className={styles.emptyMessage}>
                        {/* Distinguish an unmatched search from unmatched filter chips — same convention as inbox/calendar. */}
                        {deferredQuery.trim() ? 'No next actions match your search.' : 'No next actions match the current filters.'}
                    </Text>
                )
            ) : (
                // Windowed rendering — only rows near the viewport mount, so a large next-actions list
                // doesn't block the main thread on navigation. Day headers interleave with the rows, so
                // this is a named section of headers and rows rather than a <ul>. One tab stop for the
                // whole list (see useNextActionsRovingFocus): the section forwards focus to the
                // remembered row, the rows and their buttons are tabIndex -1.
                <section
                    className={styles.list}
                    aria-label="Next actions"
                    aria-describedby={ranked.hintIds.list}
                    data-testid="nextActionsList"
                    {...roving.listProps}
                >
                    <WindowVirtualizer ref={virtualizerRef}>
                        {flatRows.map((row) => {
                            if (row.kind === 'header') {
                                return (
                                    <Text
                                        key={`header-${row.section.key}`}
                                        as="div"
                                        // subtitleSm, not overline: overline's text-transform would shout "TODAY" and
                                        // turn the weekday/month casing into noise.
                                        variant="subtitleSm"
                                        className={rankedHeaderClassName(ranked, row.section)}
                                        data-testid="nextActionSectionHeader"
                                        data-section-key={row.section.key}
                                    >
                                        {row.section.label}
                                    </Text>
                                );
                            }
                            const { item, section } = row;
                            const missingLabels = missingClarifications(item, hasAtLeastOne(workContexts));
                            const rowIsGhost = isGhost(item);
                            return (
                                <ListRowShell key={item._id} itemId={item._id} isGhost={rowIsGhost} onGhostExited={onGhostExited}>
                                    <ListRow
                                        {...rankedRowProps(ranked, row)}
                                        isDivided={!row.isLastInSection}
                                        actions={
                                            <>
                                                {/* A ghost is a stale snapshot of a row that already left the list: only its id may still be copied. */}
                                                {!rowIsGhost && (
                                                    <RowActionButton
                                                        rowAction="moveTo"
                                                        label="Move to…"
                                                        icon={<EllipsisVertical />}
                                                        onClick={() => openMoveTo(item, section)}
                                                        data-testid="nextActionMoveToButton"
                                                        {...roving.actionButtonProps}
                                                    />
                                                )}
                                                <CopyIdButton
                                                    isRowAction
                                                    id={item._id}
                                                    testId="nextActionItemCopyIdButton"
                                                    buttonProps={roving.actionButtonProps}
                                                />
                                                {!rowIsGhost && (
                                                    <RowActionButton
                                                        rowAction="edit"
                                                        label="Edit"
                                                        icon={<Pencil />}
                                                        onClick={(e) => editor.openEditor({ item, event: e })}
                                                        data-testid="nextActionItemEditButton"
                                                        {...roving.actionButtonProps}
                                                    />
                                                )}
                                                {!rowIsGhost && (
                                                    <RowActionButton
                                                        rowAction="done"
                                                        label="Mark done"
                                                        icon={<CircleCheck />}
                                                        tone="success"
                                                        onClick={() => void onDone(item)}
                                                        data-testid="nextActionItemDoneButton"
                                                        {...roving.actionButtonProps}
                                                    />
                                                )}
                                            </>
                                        }
                                    >
                                        {/* A real button beside (not inside) the row button — nested interactive content is
                                            invalid ARIA, and the row's ripple/click would fire on every drop. A ghost (a row
                                            fading out of this list) gets none: it is not a valid drag source. */}
                                        {!rowIsGhost && <RankedRowHandle ranked={ranked} item={item} section={section} testId="nextActionDragHandle" />}
                                        <ListRowButton
                                            onActivate={(e) => editor.openEditor({ item, event: e })}
                                            data-testid="nextActionItemRow"
                                            // Short, per row (screen readers re-read it on every row focus); the full key list sits on the list and the handle.
                                            {...rankedRowButtonProps(ranked)}
                                        >
                                            <ListRowText
                                                primary={
                                                    <span className={styles.titleRow}>
                                                        {item.urgent && <Zap size={20} className={styles.urgentIcon} aria-label="Urgent" />}
                                                        <span>{item.title}</span>
                                                        {item.energy && <Chip label={energyLabels[item.energy]} tone={energyTones[item.energy]} />}
                                                        {item.time !== undefined && <Chip label={`${item.time} min`} variant="outline" />}
                                                        {hasAtLeastOne(missingLabels) && <UnclarifiedWarning missingLabels={missingLabels} />}
                                                        {item.routineId && (
                                                            <RoutineIndicator routineId={item.routineId} routineTitle={routineTitleById.get(item.routineId)} />
                                                        )}
                                                        <AccountChip userId={item.userId} />
                                                    </span>
                                                }
                                                secondary={buildRowSecondary(item, { showTags, contextsById, peopleById })}
                                            />
                                        </ListRowButton>
                                    </ListRow>
                                </ListRowShell>
                            );
                        })}
                    </WindowVirtualizer>
                </section>
            )}
            {/* Keyboard hints, the polite announcer for every reorder outcome, the failure toast and the Move to sheet. */}
            <RankedListChrome ranked={ranked} actions={NEXT_ACTIONS_ROW_ACTIONS} sectionNoun="day" liveTestId="nextActionsReorderLive" />
            <Toast open={editor.toast.open} autoHideDuration={3000} onClose={editor.closeToast} message={editor.toast.message} />
        </div>
    );
}
