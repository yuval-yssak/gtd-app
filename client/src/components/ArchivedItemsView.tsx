import { Link } from '@tanstack/react-router';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { memo, type ReactElement, useMemo, useState } from 'react';
import { WindowVirtualizer } from 'virtua';
import { useAppData } from '../contexts/AppDataProvider';
import { Card, Chip, Select, Text } from '../designSystem';
import { useListGhosts } from '../hooks/useListGhosts';
import { useListScrollRestoration } from '../hooks/useListScrollRestoration';
import { useListSearch } from '../hooks/useListSearch';
import { filterItemsByQuery, type ItemSortDir, type ItemSortKey, sortItems } from '../lib/itemSearch';
import { SHORTCUT_ROW_PROPS } from '../lib/rowShortcuts';
import type { StoredItem } from '../types/MyDB';
import { AccountChip } from './AccountChip';
import { AccountSyncChip } from './AccountSyncChip';
import styles from './ArchivedItemsView.module.css';
import { CopyIdButton } from './itemEditor/CopyIdButton';
import { ListRowShell } from './ListRowShell';
import { ListSearchButton, ListSearchField } from './ListSearch';
import { ListSkeleton } from './ListSkeleton';
import { RoutineIndicator } from './RoutineIndicator';

dayjs.extend(relativeTime);

interface SortOption {
    label: string;
    key: ItemSortKey;
    dir: ItemSortDir;
}

// Encoded as `${key}:${dir}` so the value lives in a single TextField select.
const encodeSort = (key: ItemSortKey, dir: ItemSortDir) => `${key}:${dir}`;

const SORT_OPTIONS: SortOption[] = [
    { label: 'Updated · newest first', key: 'updatedTs', dir: 'desc' },
    { label: 'Updated · oldest first', key: 'updatedTs', dir: 'asc' },
    { label: 'Created · newest first', key: 'createdTs', dir: 'desc' },
    { label: 'Created · oldest first', key: 'createdTs', dir: 'asc' },
];

interface Props {
    status: Extract<StoredItem['status'], 'done' | 'trash'>;
    title: string;
    emptyIcon: ReactElement;
    emptyMessage: string;
    /** Current `q` from the owning route's URL ('' when unset). */
    urlQuery: string;
    /** Writes `q` back to the owning route's URL (replace: true). Must be referentially stable. */
    writeUrlQuery: (query: string) => void;
}

interface ArchivedRowProps {
    item: StoredItem;
    sortKey: ItemSortKey;
    routineTitle: string | undefined;
    isGhost: boolean;
    onGhostExited: (itemId: string) => void;
    hasDivider: boolean;
}

// memo: done/trash are the largest lists in the app — item identity is stable across re-renders
// (rows come straight from the IDB snapshot), so sorting/ghost updates only pay for changed rows.
const ArchivedRow = memo(function ArchivedRow({ item, sortKey, routineTitle, isGhost, onGhostExited, hasDivider }: ArchivedRowProps) {
    const verb = sortKey === 'updatedTs' ? 'Updated' : 'Created';
    return (
        <ListRowShell itemId={item._id} isGhost={isGhost} onGhostExited={onGhostExited}>
            <div {...SHORTCUT_ROW_PROPS} className={styles.row} data-divided={hasDivider || undefined}>
                <Link to="/item/$itemId" params={{ itemId: item._id }} search={{ status: null }} className={styles.rowLink}>
                    <span className={styles.titleRow}>
                        <Text as="span" variant="bodySm">
                            {item.title}
                        </Text>
                        {item.routineId && <RoutineIndicator routineId={item.routineId} routineTitle={routineTitle} />}
                        <AccountChip userId={item.userId} />
                        {item.cancelledByGCal && <Chip label="Cancelled in Calendar" tone="warning" data-testid="cancelledByGCalChip" />}
                    </span>
                    <Text as="span" variant="caption" tone="secondary">
                        {`${verb} ${dayjs(item[sortKey]).fromNow()}`}
                    </Text>
                </Link>
                <CopyIdButton isRowAction id={item._id} testId="archivedItemCopyIdButton" />
            </div>
        </ListRowShell>
    );
});

export function ArchivedItemsView({ status, title, emptyIcon, emptyMessage, urlQuery, writeUrlQuery }: Props) {
    const { items, routines, isInitialSyncing } = useAppData();
    const [sortKey, setSortKey] = useState<ItemSortKey>('updatedTs');
    const [sortDir, setSortDir] = useState<ItemSortDir>('desc');
    useListScrollRestoration();
    const { itemsWithGhosts, isGhost, onGhostExited } = useListGhosts(items);
    const search = useListSearch({ urlQuery, writeUrlQuery });
    // Deferred query: typing re-filters in an interruptible background render (see useListSearch).
    const { deferredQuery } = search;

    const archivedItems = useMemo(() => itemsWithGhosts.filter((item) => item.status === status), [itemsWithGhosts, status]);
    const filtered = useMemo(() => filterItemsByQuery(archivedItems, deferredQuery), [archivedItems, deferredQuery]);
    const sorted = useMemo(() => sortItems(filtered, sortKey, sortDir), [filtered, sortKey, sortDir]);
    const routineTitleById = useMemo(() => new Map(routines.map((r) => [r._id, r.title])), [routines]);

    // Ghosts are fading leftovers of items that just left this archive — count live rows only.
    const liveCount = filtered.filter((item) => !isGhost(item)).length;

    // Truly empty archive (no query involved) — the empty-state card, or a skeleton during bootstrap.
    if (archivedItems.length === 0) {
        return (
            <div>
                <div className={styles.titleGroup}>
                    <Text variant="title" className={styles.emptyTitle}>
                        {title}
                    </Text>
                    {/* "Syncing account…" while a newly-added account bootstraps; surfaces even when the list already has items. */}
                    <AccountSyncChip />
                </div>
                {/* During first-launch bootstrap the empty list is "not loaded yet", not "truly empty" — show the skeleton instead of the empty-state copy. */}
                {isInitialSyncing ? (
                    <ListSkeleton />
                ) : (
                    <Card padding="none" className={styles.emptyCard}>
                        <div className={styles.icon}>{emptyIcon}</div>
                        <Text variant="bodySm" tone="secondary">
                            {emptyMessage}
                        </Text>
                    </Card>
                )}
            </div>
        );
    }

    const onSortChange = (raw: string) => {
        const found = SORT_OPTIONS.find((o) => encodeSort(o.key, o.dir) === raw);
        if (!found) return;
        setSortKey(found.key);
        setSortDir(found.dir);
    };

    return (
        <div>
            <div className={styles.headerRow}>
                <div className={styles.titleGroup}>
                    <Text variant="title">
                        {title}
                        {liveCount > 0 && <Chip label={liveCount} className={styles.countChip} />}
                    </Text>
                    {/* "Syncing account…" while a newly-added account bootstraps; surfaces even when the list already has items. */}
                    <AccountSyncChip />
                    <ListSearchButton onToggle={search.toggleSearch} testId={`${status}SearchButton`} />
                </div>
                <Select
                    label="Sort by"
                    value={encodeSort(sortKey, sortDir)}
                    onValueChange={onSortChange}
                    options={SORT_OPTIONS.map((o) => ({ value: encodeSort(o.key, o.dir), label: o.label }))}
                    className={styles.sortField}
                />
            </div>
            {search.isOpen && (
                <ListSearchField
                    value={search.queryInput}
                    onValueChange={search.setQueryInput}
                    onClose={search.closeSearch}
                    placeholder={`Search ${title.toLowerCase()}…`}
                    testId={`${status}SearchInput`}
                />
            )}
            {sorted.length === 0 ? (
                <Text tone="secondary" className={styles.noMatches}>
                    No items match your search.
                </Text>
            ) : (
                /* A plain div, not <ul>: WindowVirtualizer renders a measuring <div> wrapper, invalid
                   inside a list. Windowed rendering — only rows near the viewport mount, so the unbounded
                   done/trash archives don't block the main thread on mount or navigation. */
                <div className={styles.list}>
                    <WindowVirtualizer>
                        {sorted.map((item, idx) => (
                            <ArchivedRow
                                key={item._id}
                                item={item}
                                sortKey={sortKey}
                                routineTitle={item.routineId ? routineTitleById.get(item.routineId) : undefined}
                                isGhost={isGhost(item)}
                                onGhostExited={onGhostExited}
                                hasDivider={idx < sorted.length - 1}
                            />
                        ))}
                    </WindowVirtualizer>
                </div>
            )}
        </div>
    );
}
