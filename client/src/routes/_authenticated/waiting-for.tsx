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
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { useItemEditor } from '../../components/itemEditor/useItemEditor';
import { ListSkeleton } from '../../components/ListSkeleton';
import { RoutineIndicator } from '../../components/RoutineIndicator';
import { useAppData } from '../../contexts/AppDataProvider';
import { clarifyToDone } from '../../db/itemMutations';
import type { StoredItem } from '../../types/MyDB';
import styles from './-waiting-for.module.css';

export const Route = createFileRoute('/_authenticated/waiting-for')({
    component: WaitingForPage,
});

function WaitingForPage() {
    const { db } = Route.useRouteContext();
    const { items, people, routines, workContexts, refreshItems, isInitialSyncing } = useAppData();
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
    const editor = useItemEditor({ db, people, workContexts, refreshItems, isMobile });

    const waitingItems = items.filter((item) => item.status === 'waitingFor').sort((a, b) => (a.expectedBy ?? '').localeCompare(b.expectedBy ?? ''));

    const personMap = Object.fromEntries(people.map((p) => [p._id, p.name]));

    // Group by person (or "Unassigned")
    const groups = waitingItems.reduce<Record<string, StoredItem[]>>((acc, item) => {
        const key = item.waitingForPersonId ?? '__none__';
        acc[key] = [...(acc[key] ?? []), item];
        return acc;
    }, {});

    async function onReceived(item: StoredItem) {
        await clarifyToDone(db, item, { onReadOnlyGCal: editor.onFromGmailReadOnly });
        await refreshItems();
    }

    const isOverdue = (item: StoredItem) => item.expectedBy !== undefined && item.expectedBy < dayjs().format('YYYY-MM-DD');

    if (waitingItems.length === 0) {
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
                        Waiting For
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
                        Nothing pending.
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
                    Waiting For
                    <Chip label={waitingItems.length} size="small" color="primary" className={styles.countChip} />
                </Typography>
                {/* "Syncing account…" while a newly-added account bootstraps; surfaces even when the list already has items. */}
                <AccountSyncChip />
            </Box>
            {Object.entries(groups).map(([personId, groupItems]) => (
                <Box
                    key={personId}
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
                        {personId === '__none__' ? 'Unassigned' : (personMap[personId] ?? 'Unknown')}
                    </Typography>
                    <List disablePadding className={styles.list}>
                        {groupItems.map((item, idx) => (
                            <Box key={item._id}>
                                <ListItem
                                    disablePadding
                                    className={styles.item}
                                    secondaryAction={
                                        <Box className={styles.actionButtons}>
                                            <CopyIdButton id={item._id} testId="waitingForItemCopyIdButton" />
                                            <Tooltip title="Edit">
                                                <IconButton size="small" onClick={() => editor.openEditor({ item })} data-testid="waitingForItemEditButton">
                                                    <EditIcon fontSize="small" />
                                                </IconButton>
                                            </Tooltip>
                                            <Tooltip title="Received">
                                                <IconButton size="small" color="success" onClick={() => void onReceived(item)}>
                                                    <CheckCircleOutlineIcon />
                                                </IconButton>
                                            </Tooltip>
                                        </Box>
                                    }
                                >
                                    <ListItemButton onClick={() => editor.openEditor({ item })} className={styles.rowButton} data-testid="waitingForItemRow">
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
                                            secondary={
                                                item.expectedBy ? (
                                                    <Typography component="span" variant="caption" color={isOverdue(item) ? 'error' : 'text.secondary'}>
                                                        Expected by {dayjs(item.expectedBy).format('MMM D')}
                                                        {isOverdue(item) && ' — overdue'}
                                                    </Typography>
                                                ) : undefined
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
