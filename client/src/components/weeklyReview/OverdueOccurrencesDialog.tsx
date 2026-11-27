import dayjs from 'dayjs';
import { AlertDialog, Button, DialogActions, DialogDescription, DialogTitle } from '../../designSystem';
import type { StoredItem, StoredRoutine } from '../../types/MyDB';
import { type OverdueChoice, overdueDatesLabel } from './routineReviewCardLogic';

interface OverdueOccurrencesDialogProps {
    routine: StoredRoutine;
    open: boolean;
    /**
     * The overdue occurrences the question names, the shown one included — display only (the host
     * re-reads the rows it writes). Kept by the host after close, so the text holds through the exit animation.
     */
    overdue: ReadonlyArray<StoredItem>;
    onChoose: (choice: OverdueChoice) => void;
    onCancel: () => void;
}

/**
 * Asked when Done lands on one of several overdue occurrences: only the user knows whether the
 * others happened too or were missed. A missed one leaves Done; Google Calendar keeps it as history.
 */
export function OverdueOccurrencesDialog({ routine, open, overdue, onChoose, onCancel }: OverdueOccurrencesDialogProps) {
    const count = overdue.length;
    return (
        <AlertDialog open={open} onClose={onCancel} size="sm" fullWidth data-testid="overdueOccurrencesDialog">
            <DialogTitle>{count} past occurrences are still open</DialogTitle>
            <DialogDescription>
                "{routine.title}" was never marked done on {overdueDatesLabel(overdue, dayjs())}.
                <br />
                <br />
                Did you do them all?
                {routine.calendarEventId && <> Missed occurrences leave Done; Google Calendar keeps them as they are.</>}
            </DialogDescription>
            <DialogActions>
                <Button onClick={onCancel} data-testid="overdueOccurrencesCancel">
                    Cancel
                </Button>
                <Button onClick={() => onChoose('thisOneDone')} data-testid="overdueOccurrencesThisOne">
                    Only this one
                </Button>
                <Button onClick={() => onChoose('thisDoneRestMissed')} data-testid="overdueOccurrencesRestMissed">
                    This one, the rest missed
                </Button>
                <Button variant="solid" onClick={() => onChoose('allDone')} data-testid="overdueOccurrencesAllDone">
                    All {count} done
                </Button>
            </DialogActions>
        </AlertDialog>
    );
}
