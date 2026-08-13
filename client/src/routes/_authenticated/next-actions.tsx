import AdjustIcon from '@mui/icons-material/Adjust';
import BoltIcon from '@mui/icons-material/Bolt';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import EditIcon from '@mui/icons-material/Edit';
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
import dayjs from 'dayjs';
import { useCallback, useMemo, useState } from 'react';
import { WindowVirtualizer } from 'virtua';
import { AccountChip } from '../../components/AccountChip';
import { AccountSyncChip } from '../../components/AccountSyncChip';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { useItemEditor } from '../../components/itemEditor/useItemEditor';
import { ListRowShell } from '../../components/ListRowShell';
import { ListSearchButton, ListSearchField } from '../../components/ListSearch';
import { ListSkeleton } from '../../components/ListSkeleton';
import { CollapsibleChipGroup } from '../../components/pickers/CollapsibleChipGroup';
import { RoutineIndicator } from '../../components/RoutineIndicator';
import { useAppData } from '../../contexts/AppDataProvider';
import { clarifyToDone } from '../../db/itemMutations';
import { useEntityUsage } from '../../hooks/useEntityUsage';
import { useListGhosts } from '../../hooks/useListGhosts';
import { useListScrollRestoration } from '../../hooks/useListScrollRestoration';
import { useListSearch } from '../../hooks/useListSearch';
import { omitArchived, rankMergedOptionsByUsage } from '../../lib/entityUsage';
import { filterItemsByQuery, itemContextTags, itemPersonRefIds, itemPersonTags, type ResolvedTag } from '../../lib/itemSearch';
import {
    filterOptionsToReferenced,
    type MergedFilterOption,
    mergeFilterOptionsByName,
    resolveSelectedFilterOption,
    type SelectedFilterOption,
    sameNameIds,
} from '../../lib/mergedFilterOptions';
import { missingClarifications } from '../../lib/missingClarifications';
import { type NextActionsUrlState, parseNextActionsSearch, TIME_FILTER_OPTIONS } from '../../lib/nextActionsUrlParams';
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

/** Same-name id groups the context/person URL filters expand to in the merged multi-account view
 *  (see mergeFilterOptionsByName). Absent groups fall back to exact single-id matching. */
export interface FilterIdGroups {
    contextIds?: ReadonlySet<string> | undefined;
    personIds?: ReadonlySet<string> | undefined;
}

export function matchesFilters(item: StoredItem, filters: NextActionsUrlState, groups: FilterIdGroups = {}): boolean {
    const today = dayjs().format('YYYY-MM-DD');
    if (item.ignoreBefore && item.ignoreBefore > today) {
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

// Nirvana-style "current focus shortlist" marker — the same flag the sort uses to float items to the top.
export function FocusIndicator() {
    return (
        <Tooltip title="In focus">
            <AdjustIcon fontSize="small" color="primary" data-testid="focusIndicator" />
        </Tooltip>
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

// Four-tier sort: focused-with-date (expectedBy asc), focused-no-date, other-with-date
// (expectedBy asc), other-no-date. Focus is the primary partition, presence of an
// expectedBy is the secondary partition within each focus group.
function compareNextActions(a: StoredItem, b: StoredItem): number {
    const aFocus = a.focus === true;
    const bFocus = b.focus === true;
    if (aFocus !== bFocus) {
        return aFocus ? -1 : 1;
    }
    const aHasDate = Boolean(a.expectedBy);
    const bHasDate = Boolean(b.expectedBy);
    if (aHasDate !== bHasDate) {
        return aHasDate ? -1 : 1;
    }
    if (!aHasDate) {
        return 0;
    }
    return (a.expectedBy ?? '').localeCompare(b.expectedBy ?? '');
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

function NextActionsPage() {
    const { db } = Route.useRouteContext();
    const { items, workContexts, people, allWorkContexts, allPeople, routines, refreshItems, isInitialSyncing } = useAppData();
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
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
    const filterGroups = useMemo<FilterIdGroups>(
        () => ({ contextIds: selectedContext?.ids, personIds: selectedPerson?.ids }),
        [selectedContext, selectedPerson],
    );

    // Deferred query: typing re-filters in an interruptible background render (see useListSearch).
    const { deferredQuery } = search;
    const visibleNextActions = useMemo(() => itemsWithGhosts.filter((item) => item.status === 'nextAction'), [itemsWithGhosts]);
    const nextActions = useMemo(() => {
        const visible = visibleNextActions.filter((item) => matchesFilters(item, urlFilters, filterGroups));
        return [...filterItemsByQuery(visible, deferredQuery)].sort(compareNextActions);
    }, [visibleNextActions, urlFilters, filterGroups, deferredQuery]);

    // Facet-style live options: each row offers only chips that still match at least one row under
    // all the OTHER filters (a zero-result chip is noise; its own filter is excluded so switching
    // between sibling values stays possible). The selected option is exempt inside
    // filterOptionsToReferenced. Rows are collapsed to the most-used chips by MergedFilterChipRow.
    const usage = useEntityUsage();
    const referencedContextIds = useMemo(() => {
        const pool = visibleNextActions.filter((item) => matchesFilters(item, { ...urlFilters, context: undefined }, { personIds: selectedPerson?.ids }));
        return new Set(filterItemsByQuery(pool, deferredQuery).flatMap((item) => item.workContextIds ?? []));
    }, [visibleNextActions, urlFilters, selectedPerson, deferredQuery]);
    const referencedPersonIds = useMemo(() => {
        const pool = visibleNextActions.filter((item) => matchesFilters(item, { ...urlFilters, person: undefined }, { contextIds: selectedContext?.ids }));
        return new Set(filterItemsByQuery(pool, deferredQuery).flatMap(itemPersonRefIds));
    }, [visibleNextActions, urlFilters, selectedContext, deferredQuery]);
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

    async function onDone(item: StoredItem) {
        await clarifyToDone(db, item, { onReadOnlyGCal: editor.onFromGmailReadOnly });
        await refreshItems();
    }

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
                <List disablePadding component="div" className={styles.list}>
                    <WindowVirtualizer>
                        {nextActions.map((item, idx) => {
                            const missingLabels = missingClarifications(item, hasAtLeastOne(workContexts));
                            return (
                                <ListRowShell key={item._id} itemId={item._id} isGhost={isGhost(item)} onGhostExited={onGhostExited}>
                                    <ListItem
                                        disablePadding
                                        className={styles.item}
                                        secondaryAction={
                                            <Box className={styles.actionButtons}>
                                                <CopyIdButton id={item._id} testId="nextActionItemCopyIdButton" />
                                                <Tooltip title="Edit">
                                                    <IconButton size="small" onClick={() => editor.openEditor({ item })} data-testid="nextActionItemEditButton">
                                                        <EditIcon fontSize="small" />
                                                    </IconButton>
                                                </Tooltip>
                                                <Tooltip title="Mark done">
                                                    <IconButton size="small" color="success" onClick={() => void onDone(item)}>
                                                        <CheckCircleOutlineIcon />
                                                    </IconButton>
                                                </Tooltip>
                                            </Box>
                                        }
                                    >
                                        <ListItemButton
                                            onClick={() => editor.openEditor({ item })}
                                            className={styles.rowButton}
                                            data-testid="nextActionItemRow"
                                        >
                                            <ListItemText
                                                primary={
                                                    <Box className={styles.titleRow}>
                                                        {item.focus === true && <FocusIndicator />}
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
                                    {idx < nextActions.length - 1 && <Divider />}
                                </ListRowShell>
                            );
                        })}
                    </WindowVirtualizer>
                </List>
            )}
            {editor.renderGlobal()}
            <Snackbar open={editor.instantToast.open} autoHideDuration={3000} onClose={editor.closeInstantToast} message={editor.instantToast.message} />
        </Box>
    );
}
