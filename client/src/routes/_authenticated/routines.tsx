import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
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
import { useState } from 'react';
import { RoutineDialog } from '../../components/routines/RoutineDialog';
import { useAppData } from '../../contexts/AppDataProvider';
import { removeRoutine } from '../../db/routineMutations';
import { formatCalendarRrule, formatRrule } from '../../lib/rruleUtils';
import type { StoredRoutine } from '../../types/MyDB';
import styles from './-routines.module.css';

export const Route = createFileRoute('/_authenticated/routines')({
    component: RoutinesPage,
});

function RoutinesPage() {
    const { db } = Route.useRouteContext();
    const { account, routines, workContexts, people, refreshRoutines, refreshItems } = useAppData();
    const [dialogRoutine, setDialogRoutine] = useState<StoredRoutine | 'new' | null>(null);

    async function onDelete(routine: StoredRoutine) {
        await removeRoutine(db, routine._id);
        await refreshRoutines();
    }

    async function onSaved() {
        await refreshRoutines();
        await refreshItems();
    }

    function routineLabel(routine: StoredRoutine): string {
        return routine.routineType === 'calendar' ? formatCalendarRrule(routine) : formatRrule(routine.rrule);
    }

    return (
        <Box>
            <Box className={styles.pageHeader}>
                <Typography variant="h5" fontWeight={600}>
                    Routines
                    {routines.length > 0 && <Chip label={routines.length} size="small" className={styles.countChip} />}
                </Typography>
                <Tooltip title="Create routine">
                    <IconButton onClick={() => setDialogRoutine('new')}>
                        <AddIcon />
                    </IconButton>
                </Tooltip>
            </Box>

            {routines.length === 0 ? (
                <Typography color="text.secondary" textAlign="center" mt={6}>
                    No routines yet. Routines auto-generate next actions on a schedule.
                </Typography>
            ) : (
                <List disablePadding className={styles.list}>
                    {routines.map((routine, idx) => (
                        <Box key={routine._id}>
                            <ListItem
                                disablePadding
                                className={styles.item}
                                secondaryAction={
                                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                                        <Tooltip title="Edit">
                                            <IconButton size="small" onClick={() => setDialogRoutine(routine)}>
                                                <EditIcon fontSize="small" />
                                            </IconButton>
                                        </Tooltip>
                                        <Tooltip title="Delete">
                                            <IconButton size="small" color="error" onClick={() => void onDelete(routine)}>
                                                <DeleteOutlineIcon fontSize="small" />
                                            </IconButton>
                                        </Tooltip>
                                    </Box>
                                }
                            >
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
                                            <Chip label={routine.active ? 'Active' : 'Paused'} size="small" color={routine.active ? 'success' : 'default'} />
                                        </Box>
                                    }
                                    secondary={routineLabel(routine)}
                                    className={styles.listItemText}
                                />
                            </ListItem>
                            {idx < routines.length - 1 && <Divider />}
                        </Box>
                    ))}
                </List>
            )}

            {dialogRoutine !== null && account !== null && (
                <RoutineDialog
                    db={db}
                    userId={account.id}
                    workContexts={workContexts}
                    people={people}
                    routine={dialogRoutine === 'new' ? undefined : dialogRoutine}
                    onClose={() => setDialogRoutine(null)}
                    onSaved={onSaved}
                />
            )}
        </Box>
    );
}
