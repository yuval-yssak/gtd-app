import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import { createFileRoute } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useAppData } from '../../contexts/AppDataContext';
import styles from './calendar.module.css';

export const Route = createFileRoute('/_authenticated/calendar')({
    component: CalendarPage,
});

function CalendarPage() {
    const { items } = useAppData();

    const calendarItems = items.filter((item) => item.status === 'calendar').sort((a, b) => (a.timeStart ?? '').localeCompare(b.timeStart ?? ''));

    // Group by date label (Today / Tomorrow / date string)
    const groups = calendarItems.reduce<Record<string, typeof calendarItems>>((acc, item) => {
        const date = item.timeStart ? dayjs(item.timeStart).format('YYYY-MM-DD') : 'No date';
        acc[date] = [...(acc[date] ?? []), item];
        return acc;
    }, {});

    function dateLabel(dateKey: string): string {
        if (dateKey === 'No date') return 'No date';
        const d = dayjs(dateKey);
        if (d.isSame(dayjs(), 'day')) return 'Today';
        if (d.isSame(dayjs().add(1, 'day'), 'day')) return 'Tomorrow';
        return d.format('dddd, MMM D');
    }

    const isPast = (dateKey: string) => dateKey !== 'No date' && dayjs(dateKey).isBefore(dayjs(), 'day');

    if (calendarItems.length === 0) {
        return (
            <Box>
                <Typography variant="h5" fontWeight={600} mb={3}>
                    Calendar
                </Typography>
                <Typography color="text.secondary" textAlign="center" mt={6}>
                    No upcoming calendar items.
                </Typography>
            </Box>
        );
    }

    return (
        <Box>
            <Typography variant="h5" fontWeight={600} mb={3}>
                Calendar
            </Typography>
            {Object.entries(groups).map(([dateKey, groupItems]) => (
                <Box key={dateKey} mb={3}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                        <Typography variant="subtitle2" color="text.secondary" fontWeight={600}>
                            {dateLabel(dateKey)}
                        </Typography>
                        {isPast(dateKey) && <Chip label="Past" size="small" color="default" />}
                    </Box>
                    <List disablePadding className={styles.list}>
                        {groupItems.map((item, idx) => (
                            <Box key={item._id}>
                                <ListItem disablePadding className={styles.item}>
                                    <Box className={styles.timeCol}>
                                        {item.timeStart && (
                                            <Typography variant="caption" color="text.secondary">
                                                {dayjs(item.timeStart).format('h:mm a')}
                                                {item.timeEnd && ` – ${dayjs(item.timeEnd).format('h:mm a')}`}
                                            </Typography>
                                        )}
                                    </Box>
                                    <ListItemText primary={item.title} />
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
