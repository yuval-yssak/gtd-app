import { Link } from '@tanstack/react-router';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { memo } from 'react';
import { WindowVirtualizer } from 'virtua';
import { Text } from '../../designSystem';
import { groupByStatus, STATUS_LABELS } from '../../lib/itemSearch';
import { SHORTCUT_ROW_PROPS } from '../../lib/rowShortcuts';
import type { SearchView } from '../../lib/searchUrlParams';
import type { StoredItem } from '../../types/MyDB';
import { AccountChip } from '../AccountChip';
import { CopyIdButton } from '../itemEditor/CopyIdButton';
import { ListRow, ListRowText } from '../listRow/ListRow';
import styles from './SearchResultsList.module.css';
import { StatusChip } from './StatusChip';

dayjs.extend(relativeTime);

interface Props {
    items: readonly StoredItem[];
    view: Exclude<SearchView, 'table'>;
}

const renderItemSecondary = (item: StoredItem) => `Updated ${dayjs(item.updatedTs).fromNow()}`;

// memo: rows are the dominant render cost on large result sets. Item objects come straight from
// the IDB snapshot, so their identity is stable across keystrokes/filter re-renders — memo turns
// a full-list reconcile into a prop comparison per row.
const ResultRow = memo(function ResultRow({ item, showStatusChip, isDivided }: { item: StoredItem; showStatusChip: boolean; isDivided: boolean }) {
    return (
        <ListRow {...SHORTCUT_ROW_PROPS} isDivided={isDivided} actions={<CopyIdButton isRowAction id={item._id} testId="searchResultCopyIdButton" />}>
            {/* The whole row body is the link to the item page. */}
            <Link to="/item/$itemId" params={{ itemId: item._id }} search={{ status: null }} className={styles.rowLink}>
                <ListRowText
                    primary={
                        <>
                            <span>{item.title}</span>
                            {showStatusChip && <StatusChip status={item.status} />}
                            <AccountChip userId={item.userId} />
                        </>
                    }
                    secondary={renderItemSecondary(item)}
                />
            </Link>
        </ListRow>
    );
});

function FlatList({ items, showStatusChip }: { items: readonly StoredItem[]; showStatusChip: boolean }) {
    return (
        <div className={styles.list}>
            {/* Windowed rendering — only rows near the viewport mount, so a thousands-row result
                set doesn't block the main thread on mount or filter changes. virtua renders the <ul>/<li>. */}
            <WindowVirtualizer as="ul" item="li">
                {items.map((item, idx) => (
                    // data-list-item-id: scroll-restoration anchor (see useListScrollRestoration)
                    <div key={item._id} data-list-item-id={item._id}>
                        <ResultRow item={item} showStatusChip={showStatusChip} isDivided={idx < items.length - 1} />
                    </div>
                ))}
            </WindowVirtualizer>
        </div>
    );
}

function GroupedList({ items }: { items: readonly StoredItem[] }) {
    const groups = groupByStatus(items);
    return (
        <div>
            {groups.map((group) => (
                // Named by its heading, so each status group is a navigable region.
                <section key={group.status} className={styles.group} aria-labelledby={`search-group-${group.status}`}>
                    <div className={styles.groupHeader}>
                        <Text variant="subtitleSm" tone="secondary" id={`search-group-${group.status}`}>
                            {STATUS_LABELS[group.status]}
                        </Text>
                        <Text as="span" variant="caption" tone="secondary">
                            {group.items.length}
                        </Text>
                    </div>
                    <FlatList items={group.items} showStatusChip={false} />
                </section>
            ))}
        </div>
    );
}

// memo: skips the results subtree entirely on urgent keystroke renders — `items` only changes
// identity when the deferred filter pass commits (see search.tsx).
export const SearchResultsList = memo(function SearchResultsList({ items, view }: Props) {
    if (view === 'grouped') return <GroupedList items={items} />;
    return <FlatList items={items} showStatusChip={view === 'flatChip'} />;
});
