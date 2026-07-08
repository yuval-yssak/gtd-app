import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import { Link } from '@tanstack/react-router';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { memo } from 'react';
import { WindowVirtualizer } from 'virtua';
import { groupByStatus, STATUS_LABELS } from '../../lib/itemSearch';
import type { SearchView } from '../../lib/searchUrlParams';
import type { StoredItem } from '../../types/MyDB';
import { AccountChip } from '../AccountChip';
import { CopyIdButton } from '../itemEditor/CopyIdButton';
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
const ResultRow = memo(function ResultRow({ item, showStatusChip }: { item: StoredItem; showStatusChip: boolean }) {
    return (
        <ListItem disablePadding secondaryAction={<CopyIdButton id={item._id} testId="searchResultCopyIdButton" />}>
            <Link to="/item/$itemId" params={{ itemId: item._id }} search={{ status: null }} className={styles.rowLink}>
                <ListItemButton dense className={styles.rowButton}>
                    <ListItemText
                        primary={
                            <Box className={styles.titleRow}>
                                <span>{item.title}</span>
                                {showStatusChip && <StatusChip status={item.status} />}
                                <AccountChip userId={item.userId} />
                            </Box>
                        }
                        secondary={renderItemSecondary(item)}
                    />
                </ListItemButton>
            </Link>
        </ListItem>
    );
});

function FlatList({ items, showStatusChip }: { items: readonly StoredItem[]; showStatusChip: boolean }) {
    return (
        // component="div": WindowVirtualizer renders a measuring <div> wrapper, which is invalid
        // inside the default <ul>.
        <List disablePadding component="div" className={styles.list}>
            {/* Windowed rendering — only rows near the viewport mount, so a thousands-row result
                set doesn't block the main thread on mount or filter changes. */}
            <WindowVirtualizer>
                {items.map((item, idx) => (
                    // data-list-item-id: scroll-restoration anchor (see useListScrollRestoration)
                    <Box key={item._id} data-list-item-id={item._id}>
                        <ResultRow item={item} showStatusChip={showStatusChip} />
                        {idx < items.length - 1 && <Divider />}
                    </Box>
                ))}
            </WindowVirtualizer>
        </List>
    );
}

function GroupedList({ items }: { items: readonly StoredItem[] }) {
    const groups = groupByStatus(items);
    return (
        <Box>
            {groups.map((group) => (
                <Box
                    key={group.status}
                    sx={{
                        mb: 3,
                    }}
                >
                    <Box className={styles.groupHeader}>
                        <Typography
                            variant="subtitle2"
                            sx={{
                                color: 'text.secondary',
                                fontWeight: 600,
                            }}
                        >
                            {STATUS_LABELS[group.status]}
                        </Typography>
                        <Typography
                            variant="caption"
                            sx={{
                                color: 'text.secondary',
                            }}
                        >
                            {group.items.length}
                        </Typography>
                    </Box>
                    <FlatList items={group.items} showStatusChip={false} />
                </Box>
            ))}
        </Box>
    );
}

// memo: skips the results subtree entirely on urgent keystroke renders — `items` only changes
// identity when the deferred filter pass commits (see search.tsx).
export const SearchResultsList = memo(function SearchResultsList({ items, view }: Props) {
    if (view === 'grouped') return <GroupedList items={items} />;
    return <FlatList items={items} showStatusChip={view === 'flatChip'} />;
});
