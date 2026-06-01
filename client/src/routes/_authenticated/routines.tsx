import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import EditIcon from '@mui/icons-material/Edit';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import { useTheme } from '@mui/material/styles';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { AccountChip } from '../../components/AccountChip';
import { AccountSyncChip } from '../../components/AccountSyncChip';
import { CopyIdButton } from '../../components/itemEditor/CopyIdButton';
import { ListSkeleton } from '../../components/ListSkeleton';
import { useRoutineEditor } from '../../components/routineEditor/useRoutineEditor';
import { SyncingChip } from '../../components/SyncingChip';
import { useAppData } from '../../contexts/AppDataProvider';
import { pauseRoutine, removeRoutine } from '../../db/routineMutations';
import { formatCalendarRrule, formatRrule } from '../../lib/rruleUtils';
import type { StoredRoutine } from '../../types/MyDB';
import styles from './-routines.module.css';

export const Route = createFileRoute('/_authenticated/routines')({
    component: RoutinesPage,
});

function RoutinesPage() {
    const { db } = Route.useRouteContext();
    const { account, routines, workContexts, people, refreshRoutines, refreshItems, syncAndRefresh, isInitialSyncing, isCalendarSyncing } = useAppData();
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
    const editor = useRoutineEditor({
        db,
        userId: account?.id ?? '',
        people,
        workContexts,
        refreshRoutines,
        refreshItems,
        isMobile,
    });
    const [routineToDelete, setRoutineToDelete] = useState<StoredRoutine | null>(null);
    const [routineToPause, setRoutineToPause] = useState<StoredRoutine | null>(null);

    async function onConfirmDelete() {
        if (!routineToDelete) {
            return;
        }
        // Close dialog synchronously + snapshot the target: prevents a double-click from
        // re-entering this handler with the same routineToDelete (would enqueue a duplicate delete op).
        const target = routineToDelete;
        setRoutineToDelete(null);
        await removeRoutine(db, target._id);
        await refreshRoutines();
        // Push the delete + pull the server cascade (trashed generated calendar items)
        // so the Calendar view reflects the removal without waiting for an SSE tick.
        await syncAndRefresh();
    }

    async function onConfirmPause() {
        if (!routineToPause || !account) {
            return;
        }
        const target = routineToPause;
        setRoutineToPause(null);
        await pauseRoutine(db, account.id, target);
        await refreshRoutines();
        await refreshItems();
        // Sync + pull so the GCal-cap echo lands promptly.
        await syncAndRefresh();
    }

    function routineLabel(routine: StoredRoutine): string {
        return routine.routineType === 'calendar' ? formatCalendarRrule(routine) : formatRrule(routine.rrule);
    }

    function onRowClick(routine: StoredRoutine, e: React.MouseEvent<HTMLElement>) {
        editor.openEditor({ routine, anchor: e.currentTarget });
    }

    return (
        <Box>
            <Box className={styles.pageHeader}>
                {/* Title + sync chip grouped so the chip stays beside the title; the parent's
                    space-between keeps the create button on the right. */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography
                        variant="h5"
                        sx={{
                            fontWeight: 600,
                        }}
                    >
                        Routines
                        {routines.length > 0 && <Chip label={routines.length} size="small" className={styles.countChip} />}
                    </Typography>
                    {/* Routines surface GCal-linked recurring series, so a calendar sync can change them. */}
                    {isCalendarSyncing && <SyncingChip label="Syncing calendar…" />}
                    <AccountSyncChip />
                </Box>
                <Tooltip title="Create routine">
                    <IconButton onClick={() => editor.openEditor({})} data-testid="newRoutineButton">
                        <AddIcon />
                    </IconButton>
                </Tooltip>
            </Box>
            {routines.length === 0 ? (
                // First-launch bootstrap: skeleton while IDB loads; "no routines" copy only once loaded.
                isInitialSyncing ? (
                    <ListSkeleton />
                ) : (
                    <Typography
                        sx={{
                            color: 'text.secondary',
                            textAlign: 'center',
                            mt: 6,
                        }}
                    >
                        No routines yet. Routines auto-generate next actions on a schedule.
                    </Typography>
                )
            ) : (
                <List disablePadding className={styles.list}>
                    {routines.map((routine, idx) => (
                        <Box key={routine._id}>
                            <ListItem
                                disablePadding
                                className={styles.item}
                                secondaryAction={
                                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                                        <CopyIdButton id={routine._id} testId="routineRowCopyIdButton" />
                                        {routine.active ? (
                                            <Tooltip title="Pause">
                                                <IconButton size="small" onClick={() => setRoutineToPause(routine)} data-testid="routineRowPauseButton">
                                                    <PauseIcon fontSize="small" />
                                                </IconButton>
                                            </Tooltip>
                                        ) : (
                                            <Tooltip title="Resume — opens editor to set a new start date">
                                                {/* No anchor passed: popover mode is too wide to attach to a 24px icon, so
                                                    icon-button gestures fall through to dialog while row-body clicks still anchor. */}
                                                <IconButton
                                                    size="small"
                                                    color="success"
                                                    onClick={() => editor.openEditor({ routine })}
                                                    data-testid="routineRowResumeButton"
                                                >
                                                    <PlayArrowIcon fontSize="small" />
                                                </IconButton>
                                            </Tooltip>
                                        )}
                                        <Tooltip title="Edit">
                                            <IconButton size="small" onClick={() => editor.openEditor({ routine })} data-testid="routineRowEditButton">
                                                <EditIcon fontSize="small" />
                                            </IconButton>
                                        </Tooltip>
                                        <Tooltip title="Delete">
                                            <IconButton
                                                size="small"
                                                color="error"
                                                onClick={() => setRoutineToDelete(routine)}
                                                data-testid="routineRowDeleteButton"
                                            >
                                                <DeleteOutlineIcon fontSize="small" />
                                            </IconButton>
                                        </Tooltip>
                                    </Box>
                                }
                            >
                                <ListItemButton onClick={(e) => onRowClick(routine, e)} data-testid="routineRow">
                                    <ListItemText
                                        primary={
                                            <Box className={styles.titleRow}>
                                                {routine.title}
                                                <Chip
                                                    label={routine.routineType === 'calendar' ? 'Calendar' : 'Next Action'}
                                                    size="small"
                                                    variant="outlined"
                                                    color={routine.routineType === 'calendar' ? 'info' : 'default'}
                                                />
                                                <Chip
                                                    label={routine.active ? 'Active' : 'Paused'}
                                                    size="small"
                                                    color={routine.active ? 'success' : 'default'}
                                                />
                                                <AccountChip userId={routine.userId} />
                                            </Box>
                                        }
                                        secondary={routineLabel(routine)}
                                        className={styles.listItemText}
                                    />
                                </ListItemButton>
                            </ListItem>
                            {editor.renderExpandFor(routine._id)}
                            {idx < routines.length - 1 && <Divider />}
                        </Box>
                    ))}
                </List>
            )}
            {editor.renderGlobal()}
            <Dialog open={routineToDelete !== null} onClose={() => setRoutineToDelete(null)} maxWidth="sm" fullWidth>
                <DialogTitle>Delete routine?</DialogTitle>
                <DialogContent>
                    <DialogContentText>
                        {routineToDelete ? <>Delete "{routineToDelete.title}"?</> : null}
                        {routineToDelete?.routineType === 'calendar' && (
                            <>
                                <br />
                                <br />
                                This will also remove the recurring event from Google Calendar and trash all generated calendar items.
                            </>
                        )}
                    </DialogContentText>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setRoutineToDelete(null)}>Cancel</Button>
                    <Button color="error" onClick={() => void onConfirmDelete()}>
                        Delete
                    </Button>
                </DialogActions>
            </Dialog>
            <Dialog open={routineToPause !== null} onClose={() => setRoutineToPause(null)} maxWidth="sm" fullWidth>
                <DialogTitle>Pause routine?</DialogTitle>
                <DialogContent>
                    <DialogContentText>
                        {routineToPause ? <>Pause "{routineToPause.title}"?</> : null}
                        <br />
                        <br />
                        Future open items will be trashed. Past-due items are left alone.
                        {routineToPause?.routineType === 'calendar' && (
                            <>
                                <br />
                                The recurring event on Google Calendar will stop at today; past occurrences stay.
                            </>
                        )}
                        <br />
                        <br />
                        To resume, edit the routine and set a new start date.
                    </DialogContentText>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setRoutineToPause(null)}>Cancel</Button>
                    <Button variant="contained" onClick={() => void onConfirmPause()}>
                        Pause
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
