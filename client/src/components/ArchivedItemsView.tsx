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
import { memo, useMemo, useState } from 'react';
import { WindowVirtualizer } from 'virtua';
import { useAppData } from '../contexts/AppDataProvider';
import { useListGhosts } from '../hooks/useListGhosts';
import { useListScrollRestoration } from '../hooks/useListScrollRestoration';
import { useListSearch } from '../hooks/useListSearch';
import { filterItemsByQuery, type ItemSortDir, type ItemSortKey, sortItems } from '../lib/itemSearch';
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
    emptyIcon: React.ReactElement;
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
            <ListItem disablePadding secondaryAction={<CopyIdButton id={item._id} testId="archivedItemCopyIdButton" />}>
                <Link to="/item/$itemId" params={{ itemId: item._id }} search={{ status: null }} className={styles.rowLink}>
                    <ListItemButton dense className={styles.rowButton}>
                        <ListItemText
                            primary={
                                <Box className={styles.titleRow}>
                                    <span>{item.title}</span>
                                    {item.routineId && <RoutineIndicator routineId={item.routineId} routineTitle={routineTitle} />}
                                    <AccountChip userId={item.userId} />
                                    {item.cancelledByGCal && (
                                        <Chip label="Cancelled in Calendar" size="small" color="warning" data-testid="cancelledByGCalChip" />
                                    )}
                                </Box>
                            }
                            secondary={`${verb} ${dayjs(item[sortKey]).fromNow()}`}
                        />
                    </ListItemButton>
                </Link>
            </ListItem>
            {hasDivider && <Divider />}
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
            <Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography
                        variant="h5"
                        sx={{
                            fontWeight: 600,
                            mb: 3,
                        }}
                    >
                        {title}
                    </Typography>
                    {/* "Syncing account…" while a newly-added account bootstraps; surfaces even when the list already has items. */}
                    <AccountSyncChip />
                </Box>
                {/* During first-launch bootstrap the empty list is "not loaded yet", not "truly empty" — show the skeleton instead of the empty-state copy. */}
                {isInitialSyncing ? (
                    <ListSkeleton />
                ) : (
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
                )}
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
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography
                        variant="h5"
                        sx={{
                            fontWeight: 600,
                        }}
                    >
                        {title}
                        {liveCount > 0 && <Chip label={liveCount} size="small" className={styles.countChip} />}
                    </Typography>
                    {/* "Syncing account…" while a newly-added account bootstraps; surfaces even when the list already has items. */}
                    <AccountSyncChip />
                    <ListSearchButton onToggle={search.toggleSearch} testId={`${status}SearchButton`} />
                </Box>
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
                <Typography
                    sx={{
                        color: 'text.secondary',
                        textAlign: 'center',
                        mt: 6,
                    }}
                >
                    No items match your search.
                </Typography>
            ) : (
                /* component="div": WindowVirtualizer renders a measuring <div> wrapper, invalid inside
                   the default <ul>. Windowed rendering — only rows near the viewport mount, so the
                   unbounded done/trash archives don't block the main thread on mount or navigation. */
                <List disablePadding component="div" className={styles.list}>
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
                </List>
            )}
        </Box>
    );
}
