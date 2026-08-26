import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import type { StoredRoutine } from '../../types/MyDB';

interface PauseRoutineConfirmDialogProps {
    /** The routine about to be paused; null keeps the dialog closed. */
    routine: StoredRoutine | null;
    onCancel: () => void;
    onConfirm: () => void;
}

/** The pause gesture's confirm: names what pausing destroys (future open items, the GCal series tail) before committing. */
export function PauseRoutineConfirmDialog({ routine, onCancel, onConfirm }: PauseRoutineConfirmDialogProps) {
    return (
        <Dialog open={routine !== null} onClose={onCancel} maxWidth="sm" fullWidth>
            <DialogTitle>Pause routine?</DialogTitle>
            <DialogContent>
                <DialogContentText>
                    {routine ? <>Pause "{routine.title}"?</> : null}
                    <br />
                    <br />
                    Future open items will be trashed. Past-due items are left alone.
                    {routine?.routineType === 'calendar' && (
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
                <Button onClick={onCancel}>Cancel</Button>
                <Button variant="contained" onClick={onConfirm} data-testid="pauseRoutineConfirm">
                    Pause
                </Button>
            </DialogActions>
        </Dialog>
    );
}
