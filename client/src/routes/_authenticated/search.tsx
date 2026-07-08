import GridViewIcon from '@mui/icons-material/GridView';
import TableRowsIcon from '@mui/icons-material/TableRows';
import ViewListIcon from '@mui/icons-material/ViewList';
import ViewModuleIcon from '@mui/icons-material/ViewModule';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';
import { SearchFilters } from '../../components/search/SearchFilters';
import { SearchResultsList } from '../../components/search/SearchResultsList';
import { SearchResultsTable } from '../../components/search/SearchResultsTable';
import { useAppData } from '../../contexts/AppDataProvider';
import { useListScrollRestoration } from '../../hooks/useListScrollRestoration';
import { useListSearch } from '../../hooks/useListSearch';
import { filterItems, sortItems } from '../../lib/itemSearch';
import { loadVisibleColumns, type SearchTableColumnId, saveVisibleColumns } from '../../lib/searchTableColumns';
import { DEFAULT_URL_STATE, parseSearchParams, type SearchUrlState, type SearchView, urlStateToFilters } from '../../lib/searchUrlParams';
import styles from './-search.module.css';

export const Route = createFileRoute('/_authenticated/search')({
    validateSearch: parseSearchParams,
    component: SearchPage,
});

const VIEW_OPTIONS: Array<{ value: SearchView; icon: React.ReactElement; label: string }> = [
    { value: 'grouped', icon: <ViewModuleIcon fontSize="small" />, label: 'Grouped by status' },
    { value: 'flatChip', icon: <ViewListIcon fontSize="small" />, label: 'Flat list with status chips' },
    { value: 'flatMinimal', icon: <GridViewIcon fontSize="small" />, label: 'Flat minimal' },
    { value: 'table', icon: <TableRowsIcon fontSize="small" />, label: 'Table' },
];

function SearchPage() {
    const urlState = Route.useSearch();
    const navigate = useNavigate();
    useListScrollRestoration();
    const { items, people, workContexts, allPeople, allWorkContexts } = useAppData();

    // Input mirroring, deferred filtering, and the debounced URL write all live in useListSearch —
    // the same pipeline the virtualized list pages use for their in-page search fields.
    const writeUrlQuery = useCallback(
        (query: string) => void navigate({ to: '/search', search: { ...urlState, q: query }, replace: true }),
        [navigate, urlState],
    );
    const { queryInput, setQueryInput, deferredQuery } = useListSearch({ urlQuery: urlState.q, writeUrlQuery });
    const [visibleColumns, setVisibleColumns] = useState<Set<SearchTableColumnId>>(() => loadVisibleColumns());

    const updateUrlState = (patch: Partial<SearchUrlState>) => {
        // replace: true so live filter changes don't pollute browser history.
        void navigate({ to: '/search', search: { ...urlState, ...patch }, replace: true });
    };

    function resetFilters() {
        setQueryInput('');
        void navigate({ to: '/search', search: { ...DEFAULT_URL_STATE, view: urlState.view }, replace: true });
    }

    // Stable identity so the memoized SearchResultsTable isn't re-rendered by unrelated state.
    const onColumnsChange = useCallback((next: Set<SearchTableColumnId>) => {
        setVisibleColumns(next);
        saveVisibleColumns(next);
    }, []);

    // Query comes from the deferred input (see above) — the other filters still read the URL.
    const filters = useMemo(() => ({ ...urlStateToFilters(urlState), query: deferredQuery }), [urlState, deferredQuery]);
    const activeStatuses = filters.statuses;
    const filtered = useMemo(() => sortItems(filterItems(items, filters), 'updatedTs', 'desc'), [items, filters]);

    // Distinguish "no inputs yet, show a hint" from "inputs entered, but nothing matched".
    // Reads deferredQuery (not urlState.q) so the hint matches what the rendered list filtered on.
    const hasNoInputs =
        deferredQuery.length === 0 &&
        urlState.statuses === null &&
        urlState.personId === null &&
        urlState.contextId === null &&
        urlState.dateFrom === null &&
        urlState.dateTo === null;

    return (
        <Box>
            <Typography
                variant="h5"
                sx={{
                    fontWeight: 600,
                    mb: 3,
                }}
            >
                Search
                {filtered.length > 0 && <Chip label={filtered.length} size="small" color="primary" className={styles.countChip} />}
            </Typography>
            <SearchFilters
                urlState={urlState}
                queryInput={queryInput}
                onQueryInputChange={setQueryInput}
                onUrlStateChange={updateUrlState}
                onReset={resetFilters}
                people={people}
                workContexts={workContexts}
                activeStatuses={activeStatuses}
            />
            <Box className={styles.viewRow}>
                <ToggleButtonGroup
                    size="small"
                    value={urlState.view}
                    exclusive
                    onChange={(_, value: SearchView | null) => value && updateUrlState({ view: value })}
                >
                    {VIEW_OPTIONS.map((opt) => (
                        <ToggleButton key={opt.value} value={opt.value} aria-label={opt.label}>
                            <Tooltip title={opt.label}>{opt.icon}</Tooltip>
                        </ToggleButton>
                    ))}
                </ToggleButtonGroup>
            </Box>
            {filtered.length === 0 ? (
                <Typography
                    sx={{
                        color: 'text.secondary',
                        textAlign: 'center',
                        mt: 6,
                    }}
                >
                    {hasNoInputs ? 'Type to search or use the filters above.' : 'No items match your filters.'}
                </Typography>
            ) : urlState.view === 'table' ? (
                <SearchResultsTable
                    items={filtered}
                    visibleColumns={visibleColumns}
                    onVisibleColumnsChange={onColumnsChange}
                    // all* (unfiltered): result rows resolve person/context ids to names, and a
                    // visible item may reference a hidden account's entity.
                    people={allPeople}
                    workContexts={allWorkContexts}
                />
            ) : (
                <SearchResultsList items={filtered} view={urlState.view} />
            )}
        </Box>
    );
}
