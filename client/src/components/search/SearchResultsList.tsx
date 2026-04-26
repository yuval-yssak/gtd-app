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
import { groupByStatus, STATUS_LABELS } from '../../lib/itemSearch';
import type { SearchView } from '../../lib/searchUrlParams';
import type { StoredItem } from '../../types/MyDB';
import styles from './SearchResultsList.module.css';
import { StatusChip } from './StatusChip';

dayjs.extend(relativeTime);

interface Props {
    items: readonly StoredItem[];
    view: Exclude<SearchView, 'table'>;
}

const renderItemSecondary = (item: StoredItem) => `Updated ${dayjs(item.updatedTs).fromNow()}`;

function ResultRow({ item, showStatusChip }: { item: StoredItem; showStatusChip: boolean }) {
    return (
        <ListItem disablePadding>
            <Link to="/item/$itemId" params={{ itemId: item._id }} search={{ dest: null }} className={styles.rowLink}>
                <ListItemButton dense>
                    <ListItemText
                        primary={
                            <Box className={styles.titleRow}>
                                <span>{item.title}</span>
                                {showStatusChip && <StatusChip status={item.status} />}
                            </Box>
                        }
                        secondary={renderItemSecondary(item)}
                    />
                </ListItemButton>
            </Link>
        </ListItem>
    );
}

function FlatList({ items, showStatusChip }: { items: readonly StoredItem[]; showStatusChip: boolean }) {
    return (
        <List disablePadding className={styles.list}>
            {items.map((item, idx) => (
                <Box key={item._id}>
                    <ResultRow item={item} showStatusChip={showStatusChip} />
                    {idx < items.length - 1 && <Divider />}
                </Box>
            ))}
        </List>
    );
}

function GroupedList({ items }: { items: readonly StoredItem[] }) {
    const groups = groupByStatus(items);
    return (
        <Box>
            {groups.map((group) => (
                <Box key={group.status} mb={3}>
                    <Box className={styles.groupHeader}>
                        <Typography variant="subtitle2" color="text.secondary" fontWeight={600}>
                            {STATUS_LABELS[group.status]}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                            {group.items.length}
                        </Typography>
                    </Box>
                    <FlatList items={group.items} showStatusChip={false} />
                </Box>
            ))}
        </Box>
    );
}

export function SearchResultsList({ items, view }: Props) {
    if (view === 'grouped') return <GroupedList items={items} />;
    return <FlatList items={items} showStatusChip={view === 'flatChip'} />;
}
