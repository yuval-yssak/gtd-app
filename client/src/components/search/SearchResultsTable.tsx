import { Link } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { Columns3 } from 'lucide-react';
import { type MouseEvent, memo, type ReactNode, useCallback, useMemo } from 'react';
import { Button, MenuCheckboxItem, MenuPopup, MenuRoot, MenuTrigger } from '../../designSystem';
import { itemContextNames, itemPersonNames } from '../../lib/itemSearch';
import { useNewTabAwareNavigate } from '../../lib/newTabNavigation';
import { SEARCH_TABLE_COLUMNS, type SearchTableColumnId } from '../../lib/searchTableColumns';
import type { StoredItem, StoredPerson, StoredWorkContext } from '../../types/MyDB';
import { AccountChip } from '../AccountChip';
import styles from './SearchResultsTable.module.css';
import { StatusChip } from './StatusChip';

interface Props {
    items: readonly StoredItem[];
    visibleColumns: ReadonlySet<SearchTableColumnId>;
    onVisibleColumnsChange: (next: Set<SearchTableColumnId>) => void;
    people: StoredPerson[];
    workContexts: StoredWorkContext[];
}

const formatDate = (iso: string | undefined) => (iso ? dayjs(iso).format('MMM D, YYYY') : '—');

function ColumnPicker({ visibleColumns, onChange }: { visibleColumns: ReadonlySet<SearchTableColumnId>; onChange: (next: Set<SearchTableColumnId>) => void }) {
    const toggleColumn = (id: SearchTableColumnId) => {
        const next = new Set(visibleColumns);
        if (next.has(id)) {
            next.delete(id);
        } else {
            next.add(id);
        }
        onChange(next);
    };

    return (
        <MenuRoot>
            <MenuTrigger
                render={
                    <Button size="sm" variant="outline" startIcon={<Columns3 />} data-testid="searchColumnsButton">
                        Columns
                    </Button>
                }
            />
            <MenuPopup align="end">
                {SEARCH_TABLE_COLUMNS.map((col) => (
                    // Stays open per toggle, so several columns can be changed in one visit.
                    <MenuCheckboxItem
                        key={col.id}
                        checked={visibleColumns.has(col.id)}
                        onCheckedChange={() => toggleColumn(col.id)}
                        disabled={col.fixed === true}
                        closeOnClick={false}
                    >
                        {col.label}
                    </MenuCheckboxItem>
                ))}
            </MenuPopup>
        </MenuRoot>
    );
}

/** What a cell renderer reads: the row's item and the id → name lookups. */
interface CellSource {
    item: StoredItem;
    peopleById: Map<string, StoredPerson>;
    contextsById: Map<string, StoredWorkContext>;
}

const namesOrDash = (names: string[]) => (names.length > 0 ? names.join(', ') : '—');

/** The title is the row's link — the keyboard way in (the row click is the pointer convenience). AccountChip hides with one account. */
function TitleCell({ item }: { item: StoredItem }) {
    return (
        <span className={styles.titleCell}>
            <Link to="/item/$itemId" params={{ itemId: item._id }} search={{ status: null }} className={styles.titleLink} data-testid="searchTableTitleLink">
                {item.title}
            </Link>
            <AccountChip userId={item.userId} />
        </span>
    );
}

/** One renderer per column — the table shows whichever subset the picker leaves visible. */
const CELL_RENDERERS: Record<SearchTableColumnId, (source: CellSource) => ReactNode> = {
    title: ({ item }) => <TitleCell item={item} />,
    status: ({ item }) => <StatusChip status={item.status} />,
    updated: ({ item }) => formatDate(item.updatedTs),
    created: ({ item }) => formatDate(item.createdTs),
    expectedBy: ({ item }) => formatDate(item.expectedBy),
    people: ({ item, peopleById }) => namesOrDash(itemPersonNames(item, peopleById)),
    contexts: ({ item, contextsById }) => namesOrDash(itemContextNames(item, contextsById)),
};

interface ResultTableRowProps {
    item: StoredItem;
    orderedColumns: typeof SEARCH_TABLE_COLUMNS;
    peopleById: Map<string, StoredPerson>;
    contextsById: Map<string, StoredWorkContext>;
    onItemOpened: (event: MouseEvent, itemId: string) => void;
}

// memo: item identity is stable across filter re-renders (rows come straight from the IDB
// snapshot), so re-filtering only pays for rows that actually entered/left the result set.
const ResultTableRow = memo(function ResultTableRow({ item, orderedColumns, peopleById, contextsById, onItemOpened }: ResultTableRowProps) {
    return (
        <tr
            // A click anywhere on the row opens the item, as the title link does; a click on the link
            // itself is the link's (so cmd/ctrl+click works there natively).
            onClick={(e) => {
                if (!(e.target instanceof Element && e.target.closest('a'))) onItemOpened(e, item._id);
            }}
            className={styles.row}
            // data-list-item-id: scroll-restoration anchor (see useListScrollRestoration);
            // set directly on the <tr> — wrapping table rows in a div would break table semantics.
            data-list-item-id={item._id}
            data-testid="searchTableRow"
        >
            {orderedColumns.map((col) => (
                <td key={col.id}>{CELL_RENDERERS[col.id]({ item, peopleById, contextsById })}</td>
            ))}
        </tr>
    );
});

// memo: skips the whole table on urgent keystroke renders — `items` only changes identity when
// the deferred filter pass commits (see search.tsx).
export const SearchResultsTable = memo(function SearchResultsTable({ items, visibleColumns, onVisibleColumnsChange, people, workContexts }: Props) {
    const navigateOrNewTab = useNewTabAwareNavigate();
    const peopleById = useMemo(() => new Map(people.map((p) => [p._id, p])), [people]);
    const contextsById = useMemo(() => new Map(workContexts.map((c) => [c._id, c])), [workContexts]);
    const orderedColumns = useMemo(() => SEARCH_TABLE_COLUMNS.filter((c) => visibleColumns.has(c.id)), [visibleColumns]);
    const onItemOpened = useCallback(
        (event: MouseEvent, itemId: string) => navigateOrNewTab(event, { to: '/item/$itemId', params: { itemId }, search: { status: null } }),
        [navigateOrNewTab],
    );

    return (
        <>
            <div className={styles.toolbar}>
                <ColumnPicker visibleColumns={visibleColumns} onChange={onVisibleColumnsChange} />
            </div>
            <div className={styles.tableFrame}>
                <table className={styles.table}>
                    <thead>
                        <tr>
                            {orderedColumns.map((col) => (
                                <th key={col.id} scope="col">
                                    {col.label}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {items.map((item) => (
                            <ResultTableRow
                                key={item._id}
                                item={item}
                                orderedColumns={orderedColumns}
                                peopleById={peopleById}
                                contextsById={contextsById}
                                onItemOpened={onItemOpened}
                            />
                        ))}
                    </tbody>
                </table>
            </div>
        </>
    );
});
