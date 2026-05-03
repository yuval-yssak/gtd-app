import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { Link } from '@tanstack/react-router';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { useState } from 'react';
import { useAppData } from '../contexts/AppDataProvider';
import { type ItemSortDir, type ItemSortKey, sortItems } from '../lib/itemSearch';
import type { StoredItem } from '../types/MyDB';
import { AccountChip } from './AccountChip';
import styles from './ArchivedItemsView.module.css';
import { PageLoadingSpinner } from './PageLoadingSpinner';
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
    emptyIcon: React.ReactElement;
    emptyMessage: string;
}

export function ArchivedItemsView({ status, title, emptyIcon, emptyMessage }: Props) {
    const { items, routines, isInitialLoading } = useAppData();
    const [sortKey, setSortKey] = useState<ItemSortKey>('updatedTs');
    const [sortDir, setSortDir] = useState<ItemSortDir>('desc');

    const filtered = items.filter((item) => item.status === status);
    const sorted = sortItems(filtered, sortKey, sortDir);

    if (isInitialLoading) {
        return (
            <Box>
                <Typography
                    variant="h5"
                    sx={{
                        fontWeight: 600,
                        mb: 3,
                    }}
                >
                    {title}
                </Typography>
                <PageLoadingSpinner />
            </Box>
        );
    }

    if (filtered.length === 0) {
        return (
            <Box>
                <Typography
                    variant="h5"
                    sx={{
                        fontWeight: 600,
                        mb: 3,
                    }}
                >
                    {title}
                </Typography>
                <Paper variant="outlined" className={styles.emptyCard}>
                    <Box className={styles.icon}>{emptyIcon}</Box>
                    <Typography
                        variant="body2"
                        sx={{
                            color: 'text.secondary',
                        }}
                    >
                        {emptyMessage}
                    </Typography>
                </Paper>
            </Box>
        );
    }

    const onSortChange = (raw: string) => {
        const found = SORT_OPTIONS.find((o) => encodeSort(o.key, o.dir) === raw);
        if (!found) return;
        setSortKey(found.key);
        setSortDir(found.dir);
    };

    return (
        <Box>
            <Box className={styles.headerRow}>
                <Typography
                    variant="h5"
                    sx={{
                        fontWeight: 600,
                    }}
                >
                    {title}
                    <Chip label={filtered.length} size="small" className={styles.countChip} />
                </Typography>
                <TextField
                    size="small"
                    select
                    label="Sort by"
                    value={encodeSort(sortKey, sortDir)}
                    onChange={(e) => onSortChange(e.target.value)}
                    className={styles.sortField}
                >
                    {SORT_OPTIONS.map((o) => (
                        <MenuItem key={encodeSort(o.key, o.dir)} value={encodeSort(o.key, o.dir)}>
                            {o.label}
                        </MenuItem>
                    ))}
                </TextField>
            </Box>
            <List disablePadding className={styles.list}>
                {sorted.map((item, idx) => {
                    const ts = item[sortKey];
                    const verb = sortKey === 'updatedTs' ? 'Updated' : 'Created';
                    return (
                        <Box key={item._id}>
                            <ListItem disablePadding>
                                <Link to="/item/$itemId" params={{ itemId: item._id }} search={{ dest: null }} className={styles.rowLink}>
                                    <ListItemButton dense>
                                        <ListItemText
                                            primary={
                                                <Box className={styles.titleRow}>
                                                    <span>{item.title}</span>
                                                    {item.routineId && (
                                                        <RoutineIndicator
                                                            routineId={item.routineId}
                                                            routineTitle={routines.find((r) => r._id === item.routineId)?.title}
                                                        />
                                                    )}
                                                    <AccountChip userId={item.userId} />
                                                </Box>
                                            }
                                            secondary={`${verb} ${dayjs(ts).fromNow()}`}
                                        />
                                    </ListItemButton>
                                </Link>
                            </ListItem>
                            {idx < sorted.length - 1 && <Divider />}
                        </Box>
                    );
                })}
            </List>
        </Box>
    );
}
