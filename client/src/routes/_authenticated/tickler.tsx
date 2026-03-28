import EventAvailableIcon from '@mui/icons-material/EventAvailable';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { createFileRoute } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useAppData } from '../../contexts/AppDataContext';
import { updateItem } from '../../db/itemMutations';
import type { StoredItem } from '../../types/MyDB';
import styles from './tickler.module.css';

export const Route = createFileRoute('/_authenticated/tickler')({
    component: TicklerPage,
});

function TicklerPage() {
    const { db } = Route.useRouteContext();
    const { items, refreshItems } = useAppData();

    const today = dayjs().format('YYYY-MM-DD');
    const ticklerItems = items
        .filter((item) => item.ignoreBefore !== undefined && item.ignoreBefore > today)
        .sort((a, b) => (a.ignoreBefore ?? '').localeCompare(b.ignoreBefore ?? ''));

    const groups = ticklerItems.reduce<Record<string, StoredItem[]>>((acc, item) => {
        const key = item.ignoreBefore ?? '';
        acc[key] = [...(acc[key] ?? []), item];
        return acc;
    }, {});

    async function onRelease(item: StoredItem) {
        // Remove ignoreBefore so the item becomes visible in its normal list immediately
        const { ignoreBefore: _ib, ...rest } = item;
        await updateItem(db, rest as StoredItem);
        await refreshItems();
    }

    function dayLabel(dateStr: string): string {
        const d = dayjs(dateStr);
        const daysUntil = d.diff(dayjs(), 'day');
        if (daysUntil === 0) return 'Today';
        if (daysUntil === 1) return 'Tomorrow';
        if (daysUntil < 7) return d.format('dddd');
        return d.format('MMM D, YYYY');
    }

    if (ticklerItems.length === 0) {
        return (
            <Box>
                <Typography variant="h5" fontWeight={600} mb={3}>
                    Tickler
                </Typography>
                <Typography color="text.secondary" textAlign="center" mt={6}>
                    No items are snoozed. Items hidden with "ignore before" will appear here.
                </Typography>
            </Box>
        );
    }

    return (
        <Box>
            <Typography variant="h5" fontWeight={600} mb={3}>
                Tickler
                <Chip label={ticklerItems.length} size="small" sx={{ ml: 1.5, verticalAlign: 'middle' }} />
            </Typography>
            {Object.entries(groups).map(([dateKey, groupItems]) => (
                <Box key={dateKey} mb={3}>
                    <Typography variant="subtitle2" color="text.secondary" fontWeight={600} mb={1}>
                        {dayLabel(dateKey)} — {dayjs(dateKey).format('MMM D')}
                    </Typography>
                    <List disablePadding className={styles.list}>
                        {groupItems.map((item, idx) => (
                            <Box key={item._id}>
                                <ListItem
                                    disablePadding
                                    className={styles.item}
                                    secondaryAction={
                                        <Tooltip title="Release now">
                                            <IconButton size="small" onClick={() => void onRelease(item)}>
                                                <EventAvailableIcon fontSize="small" />
                                            </IconButton>
                                        </Tooltip>
                                    }
                                >
                                    <ListItemText primary={item.title} secondary={`Status: ${item.status}`} sx={{ pr: 6 }} />
                                </ListItem>
                                {idx < groupItems.length - 1 && <Divider />}
                            </Box>
                        ))}
                    </List>
                </Box>
            ))}
        </Box>
    );
}
