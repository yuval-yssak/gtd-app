import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { LayoutGrid, LayoutList, Rows3, Table2 } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { ListEmptyMessage } from '../../components/ListEmptyMessage';
import { ListPageHeader } from '../../components/ListPageHeader';
import { SearchFilters } from '../../components/search/SearchFilters';
import { SearchResultsList } from '../../components/search/SearchResultsList';
import { SearchResultsTable } from '../../components/search/SearchResultsTable';
import { useAppData } from '../../contexts/AppDataProvider';
import { ToggleGroup, Tooltip } from '../../designSystem';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useEntityUsage } from '../../hooks/useEntityUsage';
import { useListScrollRestoration } from '../../hooks/useListScrollRestoration';
import { useListSearch } from '../../hooks/useListSearch';
import { omitArchived } from '../../lib/entityUsage';
import { filterItems, sortItems } from '../../lib/itemSearch';
import { mergeFilterOptionsByName, resolveSelectedFilterOption, sameNameIds } from '../../lib/mergedFilterOptions';
import { loadVisibleColumns, type SearchTableColumnId, saveVisibleColumns } from '../../lib/searchTableColumns';
import { DEFAULT_URL_STATE, parseSearchParams, type SearchUrlState, type SearchView, urlStateToFilters } from '../../lib/searchUrlParams';
import styles from './-search.module.css';

export const Route = createFileRoute('/_authenticated/search')({
    validateSearch: parseSearchParams,
    component: SearchPage,
});

/** An icon segment: named by aria-label, its tooltip teaching what the icon means. */
const viewOption = (value: SearchView, icon: ReactNode, label: string) => ({
    value,
    'aria-label': label,
    label: (
        <Tooltip title={label}>
            <span className={styles.viewIcon}>{icon}</span>
        </Tooltip>
    ),
});

const VIEW_OPTIONS = [
    viewOption('grouped', <LayoutGrid size={18} />, 'Grouped by status'),
    viewOption('flatChip', <LayoutList size={18} />, 'Flat list with status chips'),
    viewOption('flatMinimal', <Rows3 size={18} />, 'Flat minimal'),
    viewOption('table', <Table2 size={18} />, 'Table'),
];

function SearchPage() {
    useDocumentTitle('Search');
    const urlState = Route.useSearch();
    const navigate = useNavigate();
    useListScrollRestoration();
    const { items, people, workContexts, allPeople, allWorkContexts } = useAppData();
    const usage = useEntityUsage();

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

    // Same-named contexts/people across signed-in accounts collapse into one chip (mirrors the
    // next-actions filter rows); archived entities are cut, keeping the selected id's whole twin
    // group so the active chip stays clickable and its match set intact.
    const mergedContextOptions = useMemo(
        () => mergeFilterOptionsByName(omitArchived(workContexts, sameNameIds(urlState.contextId ?? undefined, allWorkContexts))),
        [workContexts, urlState.contextId, allWorkContexts],
    );
    const mergedPersonOptions = useMemo(
        () => mergeFilterOptionsByName(omitArchived(people, sameNameIds(urlState.personId ?? undefined, allPeople))),
        [people, urlState.personId, allPeople],
    );
    const selectedContext = useMemo(
        () => resolveSelectedFilterOption(urlState.contextId ?? undefined, mergedContextOptions, allWorkContexts),
        [urlState.contextId, mergedContextOptions, allWorkContexts],
    );
    const selectedPerson = useMemo(
        () => resolveSelectedFilterOption(urlState.personId ?? undefined, mergedPersonOptions, allPeople),
        [urlState.personId, mergedPersonOptions, allPeople],
    );

    // Query comes from the deferred input (see above) — the other filters still read the URL.
    // The selected chip's twin-group id sets ride along so filterItems matches either account's twin.
    const filters = useMemo(
        () => ({
            ...urlStateToFilters(urlState),
            query: deferredQuery,
            ...(selectedContext ? { contextIds: selectedContext.ids } : {}),
            ...(selectedPerson ? { personIds: selectedPerson.ids } : {}),
        }),
        [urlState, deferredQuery, selectedContext, selectedPerson],
    );
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
        <div>
            <ListPageHeader title="Search" count={filtered.length} countTone="accent" />
            <SearchFilters
                urlState={urlState}
                queryInput={queryInput}
                onQueryInputChange={setQueryInput}
                onUrlStateChange={updateUrlState}
                onReset={resetFilters}
                contextOptions={mergedContextOptions}
                personOptions={mergedPersonOptions}
                selectedContext={selectedContext}
                selectedPerson={selectedPerson}
                usage={usage}
                activeStatuses={activeStatuses}
            />
            <div className={styles.viewRow}>
                <ToggleGroup value={urlState.view} onValueChange={(view) => updateUrlState({ view })} options={VIEW_OPTIONS} aria-label="Results view" />
            </div>
            {filtered.length === 0 ? (
                <ListEmptyMessage>{hasNoInputs ? 'Type to search or use the filters above.' : 'No items match your filters.'}</ListEmptyMessage>
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
        </div>
    );
}
