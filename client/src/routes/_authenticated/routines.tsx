import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
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
import { useAppData } from '../../contexts/AppDataProvider';
import { removeRoutine } from '../../db/routineMutations';
import { useRoutines } from '../../hooks/useRoutines';
import type { StoredRoutine } from '../../types/MyDB';
import styles from './routines.module.css';

export const Route = createFileRoute('/_authenticated/routines')({
    component: RoutinesPage,
});

function RoutinesPage() {
    const { db } = Route.useRouteContext();
    const { account } = useAppData();
    const routines = useRoutines(db, account?.id ?? null);

    async function onDelete(routine: StoredRoutine) {
        await removeRoutine(db, routine._id);
        // Routines aren't in the router context, so reload to reflect the deletion
        window.location.reload();
    }

    function triggerLabel(routine: StoredRoutine): string {
        if (routine.triggerMode === 'afterCompletion') {
            return `${routine.afterCompletionDelayDays ?? 1}d after completion`;
        }
        return routine.rrule ?? 'Fixed schedule';
    }

    return (
        <Box>
            <Box className={styles.pageHeader}>
                <Typography variant="h5" fontWeight={600}>
                    Routines
                    {routines.length > 0 && <Chip label={routines.length} size="small" className={styles.countChip} />}
                </Typography>
                <Tooltip title="Create routine (coming soon)">
                    <span>
                        <IconButton disabled>
                            <AddIcon />
                        </IconButton>
                    </span>
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
                                    <Tooltip title="Delete">
                                        <IconButton size="small" color="error" onClick={() => void onDelete(routine)}>
                                            <DeleteOutlineIcon fontSize="small" />
                                        </IconButton>
                                    </Tooltip>
                                }
                            >
                                <ListItemText
                                    primary={
                                        <Box className={styles.titleRow}>
                                            {routine.title}
                                            <Chip label={routine.active ? 'Active' : 'Paused'} size="small" color={routine.active ? 'success' : 'default'} />
                                        </Box>
                                    }
                                    secondary={triggerLabel(routine)}
                                    className={styles.listItemText}
                                />
                            </ListItem>
                            {idx < routines.length - 1 && <Divider />}
                        </Box>
                    ))}
                </List>
            )}
        </Box>
    );
}
