import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
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
import { AccountSyncChip } from '../../components/AccountSyncChip';
import { CalendarRowMeta } from '../../components/CalendarRowMeta';
import { groupCalendarItemsByDay, isMultiDayAllDay, NO_DATE_KEY } from '../../components/calendarRouteSort';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { useItemEditor } from '../../components/itemEditor/useItemEditor';
import { ListSkeleton } from '../../components/ListSkeleton';
import { RoutineIndicator } from '../../components/RoutineIndicator';
import { SyncingChip } from '../../components/SyncingChip';
import { useAppData } from '../../contexts/AppDataProvider';
import { clarifyToDone } from '../../db/itemMutations';
import { formatAllDayDate, fromGCalExclusive } from '../../lib/allDayDate';
import type { StoredItem } from '../../types/MyDB';
import styles from './-calendar.module.css';

export const Route = createFileRoute('/_authenticated/calendar')({
    component: CalendarPage,
});

function CalendarPage() {
    const { db } = Route.useRouteContext();
    const { items, routines, people, workContexts, refreshItems, isInitialSyncing, isCalendarSyncing } = useAppData();
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
    const editor = useItemEditor({ db, people, workContexts, refreshItems, isMobile });

    const calendarItems = items.filter((item) => item.status === 'calendar');
    // Group + sort lives in calendarRouteSort.ts so the rules (all-day first, multi-day under start date) are
    // unit-tested independently of this render path. The returned map iterates day-keys chronologically.
    const groups = groupCalendarItemsByDay(calendarItems);

    function dateLabel(dateKey: string): string {
        if (dateKey === NO_DATE_KEY) {
            return NO_DATE_KEY;
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

    const isPast = (dateKey: string) => dateKey !== NO_DATE_KEY && dayjs(dateKey).isBefore(dayjs(), 'day');

    async function onDone(item: StoredItem) {
        await clarifyToDone(db, item, { onReadOnlyGCal: editor.onFromGmailReadOnly });
        await refreshItems();
    }

    if (calendarItems.length === 0) {
        return (
            <Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3 }}>
                    <Typography
                        variant="h5"
                        sx={{
                            fontWeight: 600,
                        }}
                    >
                        Calendar
                    </Typography>
                    {isCalendarSyncing && <SyncingChip label="Syncing calendar…" />}
                    <AccountSyncChip />
                </Box>
                {/* First-launch bootstrap: skeleton while IDB loads; "no items" copy only once loaded. */}
                {isInitialSyncing ? (
                    <ListSkeleton />
                ) : (
                    <Typography
                        sx={{
                            color: 'text.secondary',
                            textAlign: 'center',
                            mt: 6,
                        }}
                    >
                        No upcoming calendar items.
                    </Typography>
                )}
            </Box>
        );
    }

    return (
        <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3 }}>
                <Typography
                    variant="h5"
                    sx={{
                        fontWeight: 600,
                    }}
                >
                    Calendar
                </Typography>
                {isCalendarSyncing && <SyncingChip label="Syncing calendar…" />}
                <AccountSyncChip />
            </Box>
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
                                            <Tooltip title="Mark done">
                                                <IconButton
                                                    size="small"
                                                    color="success"
                                                    onClick={() => void onDone(item)}
                                                    data-testid="calendarItemMarkDoneButton"
                                                >
                                                    <CheckCircleOutlineIcon />
                                                </IconButton>
                                            </Tooltip>
                                        </Box>
                                    }
                                >
                                    <ListItemButton onClick={() => editor.openEditor({ item })} className={styles.rowButton} data-testid="calendarItemRow">
                                        <Box className={styles.timeCol}>
                                            <TimeColumn item={item} />
                                        </Box>
                                        {/* pr ensures text doesn't overlap the edit button in secondaryAction */}
                                        <ListItemText
                                            primary={
                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
                                                    <span>{item.title}</span>
                                                    {item.routineId && (
                                                        <RoutineIndicator
                                                            routineId={item.routineId}
                                                            routineTitle={routines.find((r) => r._id === item.routineId)?.title}
                                                        />
                                                    )}
                                                    <AccountChip userId={item.userId} />
                                                    <CalendarRowMeta item={item} />
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

interface TimeColumnProps {
    item: StoredItem;
}

/**
 * Renders the leading time column for a calendar row. Branches on `allDay`:
 * - Multi-day all-day → "All day" chip plus an inclusive date range ("May 27 – May 29"). The
 *   incoming `timeEnd` is GCal-exclusive, so `fromGCalExclusive` converts it back for display.
 * - Single-day all-day → just the chip.
 * - Timed → existing h:mm a (– h:mm a) text.
 */
function TimeColumn({ item }: TimeColumnProps) {
    if (item.allDay) {
        const rangeLabel = buildAllDayRangeLabel(item);
        return (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, alignItems: 'flex-start' }}>
                <Chip label="All day" size="small" data-testid="calendarRowAllDayChip" />
                {rangeLabel && (
                    <Typography variant="caption" sx={{ color: 'text.secondary' }} data-testid="calendarRowAllDayRange">
                        {rangeLabel}
                    </Typography>
                )}
            </Box>
        );
    }
    if (!item.timeStart) return null;
    return (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {dayjs(item.timeStart).format('h:mm a')}
            {item.timeEnd && ` – ${dayjs(item.timeEnd).format('h:mm a')}`}
        </Typography>
    );
}

/** Returns the inclusive-range label for a multi-day all-day item, or undefined for single-day. */
function buildAllDayRangeLabel(item: StoredItem): string | undefined {
    if (!isMultiDayAllDay(item) || !item.timeStart || !item.timeEnd) return undefined;
    const inclusiveEnd = fromGCalExclusive(item.timeEnd);
    return `${formatAllDayDate(item.timeStart)} – ${formatAllDayDate(inclusiveEnd)}`;
}
