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
import { RoutineIndicator } from '../../components/RoutineIndicator';
import { useAppData } from '../../contexts/AppDataProvider';
import { clarifyToDone } from '../../db/itemMutations';
import { useListGhosts } from '../../hooks/useListGhosts';
import { useListScrollRestoration } from '../../hooks/useListScrollRestoration';
import { useListSearch } from '../../hooks/useListSearch';
import { filterItemsByQuery, itemContextTags, itemPersonTags, type ResolvedTag } from '../../lib/itemSearch';
import { missingClarifications } from '../../lib/missingClarifications';
import { type NextActionsUrlState, parseNextActionsSearch, TIME_FILTER_OPTIONS } from '../../lib/nextActionsUrlParams';
import { sortByName } from '../../lib/sortByName';
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

export function matchesFilters(item: StoredItem, filters: NextActionsUrlState): boolean {
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
    if (filters.context && !item.workContextIds?.includes(filters.context)) {
        return false;
    }
    if (filters.person && !item.peopleIds?.includes(filters.person)) {
        return false;
    }
    return true;
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
                <Chip key={`ctx-${tag.id}`} icon={<SellOutlinedIcon />} label={tag.name} size="small" variant="outlined" />
            ))}
            {personTags.map((tag) => (
                <Chip key={`person-${tag.id}`} icon={<PersonOutlineIcon />} label={tag.name} size="small" color="info" variant="outlined" />
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

    // Filter chips are sorted A→Z at this consumer site only — AppDataProvider keeps stored order for other pages.
    const sortedWorkContexts = useMemo(() => sortByName(workContexts), [workContexts]);
    const sortedPeople = useMemo(() => sortByName(people), [people]);

    // Deferred query: typing re-filters in an interruptible background render (see useListSearch).
    const { deferredQuery } = search;
    const nextActions = useMemo(() => {
        const visible = itemsWithGhosts.filter((item) => item.status === 'nextAction').filter((item) => matchesFilters(item, urlFilters));
        return [...filterItemsByQuery(visible, deferredQuery)].sort(compareNextActions);
    }, [itemsWithGhosts, urlFilters, deferredQuery]);

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
                {sortedWorkContexts.length > 0 && (
                    <Stack
                        direction="row"
                        sx={{
                            flexWrap: 'wrap',
                            gap: 0.75,
                            mb: 1,
                        }}
                    >
                        {sortedWorkContexts.map((ctx) => (
                            <Chip
                                key={ctx._id}
                                label={ctx.name}
                                size="small"
                                variant={urlFilters.context === ctx._id ? 'filled' : 'outlined'}
                                color={urlFilters.context === ctx._id ? 'primary' : 'default'}
                                onClick={() => toggleFilter('context', ctx._id)}
                                data-testid="nextActionsContextFilterChip"
                            />
                        ))}
                    </Stack>
                )}
                {sortedPeople.length > 0 && (
                    <Stack
                        direction="row"
                        sx={{
                            flexWrap: 'wrap',
                            gap: 0.75,
                            mb: 1,
                        }}
                    >
                        {sortedPeople.map((p) => (
                            <Chip
                                key={p._id}
                                icon={<PersonOutlineIcon />}
                                label={p.name}
                                size="small"
                                variant={urlFilters.person === p._id ? 'filled' : 'outlined'}
                                color={urlFilters.person === p._id ? 'info' : 'default'}
                                onClick={() => toggleFilter('person', p._id)}
                                data-testid="nextActionsPersonFilterChip"
                            />
                        ))}
                    </Stack>
                )}
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
