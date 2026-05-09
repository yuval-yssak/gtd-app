import EditIcon from '@mui/icons-material/Edit';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Snackbar from '@mui/material/Snackbar';
import { useTheme } from '@mui/material/styles';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { createFileRoute } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { AccountChip } from '../../components/AccountChip';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { useItemEditor } from '../../components/itemEditor/useItemEditor';
import { RoutineIndicator } from '../../components/RoutineIndicator';
import { useAppData } from '../../contexts/AppDataProvider';
import styles from './-calendar.module.css';

export const Route = createFileRoute('/_authenticated/calendar')({
    component: CalendarPage,
});

function CalendarPage() {
    const { db } = Route.useRouteContext();
    const { items, routines, people, workContexts, refreshItems } = useAppData();
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
    const editor = useItemEditor({ db, people, workContexts, refreshItems, isMobile });

    const calendarItems = items.filter((item) => item.status === 'calendar').sort((a, b) => (a.timeStart ?? '').localeCompare(b.timeStart ?? ''));

    // Group by date label (Today / Tomorrow / date string)
    const groups = calendarItems.reduce<Record<string, typeof calendarItems>>((acc, item) => {
        const date = item.timeStart ? dayjs(item.timeStart).format('YYYY-MM-DD') : 'No date';
        acc[date] = [...(acc[date] ?? []), item];
        return acc;
    }, {});

    function dateLabel(dateKey: string): string {
        if (dateKey === 'No date') {
            return 'No date';
        }
        const d = dayjs(dateKey);
        if (d.isSame(dayjs(), 'day')) {
            return 'Today';
        }
        if (d.isSame(dayjs().add(1, 'day'), 'day')) {
            return 'Tomorrow';
        }
        return d.format('dddd, MMM D');
    }

    const isPast = (dateKey: string) => dateKey !== 'No date' && dayjs(dateKey).isBefore(dayjs(), 'day');

    if (calendarItems.length === 0) {
        return (
            <Box>
                <Typography
                    variant="h5"
                    sx={{
                        fontWeight: 600,
                        mb: 3,
                    }}
                >
                    Calendar
                </Typography>
                <Typography
                    sx={{
                        color: 'text.secondary',
                        textAlign: 'center',
                        mt: 6,
                    }}
                >
                    No upcoming calendar items.
                </Typography>
            </Box>
        );
    }

    return (
        <Box>
            <Typography
                variant="h5"
                sx={{
                    fontWeight: 600,
                    mb: 3,
                }}
            >
                Calendar
            </Typography>
            {Object.entries(groups).map(([dateKey, groupItems]) => (
                <Box
                    key={dateKey}
                    sx={{
                        mb: 3,
                    }}
                >
                    <Box className={styles.dateHeader}>
                        <Typography
                            variant="subtitle2"
                            sx={{
                                color: 'text.secondary',
                                fontWeight: 600,
                            }}
                        >
                            {dateLabel(dateKey)}
                        </Typography>
                        {isPast(dateKey) && <Chip label="Past" size="small" color="default" />}
                    </Box>
                    <List disablePadding className={styles.list}>
                        {groupItems.map((item, idx) => (
                            <Box key={item._id}>
                                <ListItem
                                    disablePadding
                                    className={styles.item}
                                    secondaryAction={
                                        <Box className={styles.actionButtons}>
                                            <CopyIdButton id={item._id} testId="calendarItemCopyIdButton" />
                                            <Tooltip title="Edit">
                                                <IconButton size="small" onClick={() => editor.openEditor({ item })} data-testid="calendarItemEditButton">
                                                    <EditIcon fontSize="small" />
                                                </IconButton>
                                            </Tooltip>
                                        </Box>
                                    }
                                >
                                    <ListItemButton onClick={() => editor.openEditor({ item })} className={styles.rowButton} data-testid="calendarItemRow">
                                        <Box className={styles.timeCol}>
                                            {item.timeStart && (
                                                <Typography
                                                    variant="caption"
                                                    sx={{
                                                        color: 'text.secondary',
                                                    }}
                                                >
                                                    {dayjs(item.timeStart).format('h:mm a')}
                                                    {item.timeEnd && ` – ${dayjs(item.timeEnd).format('h:mm a')}`}
                                                </Typography>
                                            )}
                                        </Box>
                                        {/* pr ensures text doesn't overlap the edit button in secondaryAction */}
                                        <ListItemText
                                            primary={
                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
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
                                            className={styles.listItemText}
                                        />
                                    </ListItemButton>
                                </ListItem>
                                {editor.renderExpandFor(item._id)}
                                {idx < groupItems.length - 1 && <Divider />}
                            </Box>
                        ))}
                    </List>
                </Box>
            ))}
            {editor.renderGlobal()}
            <Snackbar open={editor.instantToast.open} autoHideDuration={3000} onClose={editor.closeInstantToast} message={editor.instantToast.message} />
        </Box>
    );
}
