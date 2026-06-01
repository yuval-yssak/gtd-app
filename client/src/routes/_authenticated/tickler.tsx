import EditIcon from '@mui/icons-material/Edit';
import EventAvailableIcon from '@mui/icons-material/EventAvailable';
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
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { useItemEditor } from '../../components/itemEditor/useItemEditor';
import { ListSkeleton } from '../../components/ListSkeleton';
import { RoutineIndicator } from '../../components/RoutineIndicator';
import { useAppData } from '../../contexts/AppDataProvider';
import { updateItem } from '../../db/itemMutations';
import type { StoredItem } from '../../types/MyDB';
import styles from './-tickler.module.css';

export const Route = createFileRoute('/_authenticated/tickler')({
    component: TicklerPage,
});

function TicklerPage() {
    const { db } = Route.useRouteContext();
    const { items, routines, people, workContexts, refreshItems, isInitialSyncing } = useAppData();
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
    const editor = useItemEditor({ db, people, workContexts, refreshItems, isMobile });

    const today = dayjs().format('YYYY-MM-DD');
    // ignoreBefore only applies to nextAction and waitingFor items — calendar items ignore it
    const ticklerItems = items
        .filter((item) => (item.status === 'nextAction' || item.status === 'waitingFor') && item.ignoreBefore !== undefined && item.ignoreBefore > today)
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
                {/* mb on the wrapper (not the Typography) so the chip stays vertically centered with the title. */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3 }}>
                    <Typography
                        variant="h5"
                        sx={{
                            fontWeight: 600,
                        }}
                    >
                        Tickler
                    </Typography>
                    {/* "Syncing account…" while a newly-added account bootstraps; surfaces even when the list already has items. */}
                    <AccountSyncChip />
                </Box>
                {/* First-launch bootstrap: show skeleton, not the "empty" copy, while IDB is still loading. */}
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
                        No items are snoozed. Items hidden with "ignore before" will appear here.
                    </Typography>
                )}
            </Box>
        );
    }

    return (
        <Box>
            {/* mb on the wrapper (not the Typography) so the chip stays vertically centered with the title. */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3 }}>
                <Typography
                    variant="h5"
                    sx={{
                        fontWeight: 600,
                    }}
                >
                    Tickler
                    <Chip label={ticklerItems.length} size="small" className={styles.countChip} />
                </Typography>
                {/* "Syncing account…" while a newly-added account bootstraps; surfaces even when the list already has items. */}
                <AccountSyncChip />
            </Box>
            {Object.entries(groups).map(([dateKey, groupItems]) => (
                <Box
                    key={dateKey}
                    sx={{
                        mb: 3,
                    }}
                >
                    <Typography
                        variant="subtitle2"
                        sx={{
                            color: 'text.secondary',
                            fontWeight: 600,
                            mb: 1,
                        }}
                    >
                        {dayLabel(dateKey)} — {dayjs(dateKey).format('MMM D')}
                    </Typography>
                    <List disablePadding className={styles.list}>
                        {groupItems.map((item, idx) => (
                            <Box key={item._id}>
                                <ListItem
                                    disablePadding
                                    className={styles.item}
                                    secondaryAction={
                                        <Box className={styles.actionButtons}>
                                            <CopyIdButton id={item._id} testId="ticklerItemCopyIdButton" />
                                            <Tooltip title="Edit">
                                                <IconButton size="small" onClick={() => editor.openEditor({ item })} data-testid="ticklerItemEditButton">
                                                    <EditIcon fontSize="small" />
                                                </IconButton>
                                            </Tooltip>
                                            <Tooltip title="Release now">
                                                <IconButton size="small" onClick={() => void onRelease(item)}>
                                                    <EventAvailableIcon fontSize="small" />
                                                </IconButton>
                                            </Tooltip>
                                        </Box>
                                    }
                                >
                                    <ListItemButton onClick={() => editor.openEditor({ item })} className={styles.rowButton} data-testid="ticklerItemRow">
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
                                            secondary={`Status: ${item.status}`}
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
