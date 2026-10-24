import { AlertDialog, Button, DialogActions, DialogDescription, DialogTitle } from '../../designSystem';
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
        <AlertDialog open={routine !== null} onClose={onCancel} size="sm" fullWidth data-testid="pauseRoutineDialog">
            <DialogTitle>Pause routine?</DialogTitle>
            <DialogDescription>
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
            </DialogDescription>
            <DialogActions>
                <Button onClick={onCancel}>Cancel</Button>
                <Button variant="solid" onClick={onConfirm} data-testid="pauseRoutineConfirm">
                    Pause
                </Button>
            </DialogActions>
        </AlertDialog>
    );
}
