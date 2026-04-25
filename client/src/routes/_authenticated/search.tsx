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
import { useEffect, useMemo, useState } from 'react';
import { SearchFilters } from '../../components/search/SearchFilters';
import { SearchResultsList } from '../../components/search/SearchResultsList';
import { SearchResultsTable } from '../../components/search/SearchResultsTable';
import { useAppData } from '../../contexts/AppDataProvider';
import { ACTIVE_STATUSES, filterItems, sortItems } from '../../lib/itemSearch';
import { loadVisibleColumns, type SearchTableColumnId, saveVisibleColumns } from '../../lib/searchTableColumns';
import { DEFAULT_URL_STATE, parseSearchParams, type SearchUrlState, type SearchView, urlStateToFilters } from '../../lib/searchUrlParams';
import styles from './-search.module.css';

const QUERY_DEBOUNCE_MS = 200;

const ACTIVE_STATUS_SET = new Set(ACTIVE_STATUSES);

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
    const { items, people, workContexts } = useAppData();

    // Mirrored from URL so typing stays responsive while URL writes are debounced.
    const [queryInput, setQueryInput] = useState(urlState.q);
    const [visibleColumns, setVisibleColumns] = useState<Set<SearchTableColumnId>>(() => loadVisibleColumns());

    const updateUrlState = (patch: Partial<SearchUrlState>) => {
        // replace: true so live filter changes don't pollute browser history.
        void navigate({ to: '/search', search: { ...urlState, ...patch }, replace: true });
    };

    // Debounce query → URL. Skip the navigate call on no-op so typing doesn't churn history.
    useEffect(() => {
        if (queryInput === urlState.q) return;
        const handle = window.setTimeout(() => {
            void navigate({ to: '/search', search: { ...urlState, q: queryInput }, replace: true });
        }, QUERY_DEBOUNCE_MS);
        return () => window.clearTimeout(handle);
    }, [queryInput, urlState, navigate]);

    // External URL changes (back/forward, programmatic resets) need to flow back into the input.
    // setState dedupes when the value matches, so unconditionally calling it is safe and avoids
    // a stale-closure read of queryInput inside the comparison.
    useEffect(() => {
        setQueryInput(urlState.q);
    }, [urlState.q]);

    function resetFilters() {
        setQueryInput('');
        void navigate({ to: '/search', search: { ...DEFAULT_URL_STATE, view: urlState.view }, replace: true });
    }

    function onColumnsChange(next: Set<SearchTableColumnId>) {
        setVisibleColumns(next);
        saveVisibleColumns(next);
    }

    const filters = useMemo(() => urlStateToFilters(urlState, ACTIVE_STATUS_SET), [urlState]);
    const activeStatuses = filters.statuses;
    const filtered = useMemo(() => sortItems(filterItems(items, filters), 'updatedTs', 'desc'), [items, filters]);

    // Distinguish "no inputs yet, show a hint" from "inputs entered, but nothing matched".
    const hasNoInputs =
        urlState.q.length === 0 &&
        urlState.statuses === null &&
        urlState.personId === null &&
        urlState.contextId === null &&
        urlState.dateFrom === null &&
        urlState.dateTo === null;

    return (
        <Box>
            <Typography variant="h5" fontWeight={600} mb={3}>
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
                <Typography color="text.secondary" textAlign="center" mt={6}>
                    {hasNoInputs ? 'Type to search or use the filters above.' : 'No items match your filters.'}
                </Typography>
            ) : urlState.view === 'table' ? (
                <SearchResultsTable
                    items={filtered}
                    visibleColumns={visibleColumns}
                    onVisibleColumnsChange={onColumnsChange}
                    people={people}
                    workContexts={workContexts}
                />
            ) : (
                <SearchResultsList items={filtered} view={urlState.view} />
            )}
        </Box>
    );
}
