import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import type { IDBPDatabase } from 'idb';
import { usePendingReassign } from '../../contexts/PendingReassignProvider';
import type { MyDB, StoredPerson, StoredRoutine, StoredWorkContext } from '../../types/MyDB';
import { CopyIdButton } from '../itemEditor/CopyIdButton';
import { RoutineEditorBody } from '../routineEditor/RoutineEditorBody';
import styles from '../routineEditor/RoutineEditorDialog.module.css';

// Re-export so existing tests (`tests/RoutineDialogReassign.test.ts`) and any future call sites
// can import the patch builder from the historical location.
export { buildRoutineEditPatch } from '../routineEditor/RoutineEditorBody';

interface Props {
    db: IDBPDatabase<MyDB>;
    userId: string;
    workContexts: StoredWorkContext[];
    people: StoredPerson[];
    /** Pass an existing routine to edit it; omit to create a new one. */
    // exactOptionalPropertyTypes requires explicit `| undefined` when the value may be undefined
    routine?: StoredRoutine | undefined;
    onClose: () => void;
    onSaved: () => Promise<void>;
}

/**
 * Thin Dialog wrapper around RoutineEditorBody. Short-circuits to RoutineReassignInFlightDialog
 * when a cross-account move is mid-flight on this routine — opening the body in that state would
 * seed ownerUserId from the overlayed (target) user and a save would write IDB under the target,
 * which is the precise misroute the reassign flow exists to prevent.
 *
 * The body's local state is keyed off `routine._id` (or `'new'`) so opening the dialog on a
 * different routine forces a remount and form-state reset.
 */
export function RoutineDialog({ db, userId, workContexts, people, routine, onClose, onSaved }: Props) {
    const { isPending } = usePendingReassign();
    if (routine !== undefined && isPending('routine', routine._id)) {
        return <RoutineReassignInFlightDialog onClose={onClose} />;
    }
    return (
        <Dialog open onClose={onClose} fullWidth maxWidth="sm">
            <DialogTitle className={styles.dialogTitle}>
                <span>{routine ? 'Edit routine' : 'New routine'}</span>
                {routine && <CopyIdButton id={routine._id} />}
            </DialogTitle>
            <DialogContent className={styles.dialogContent}>
                <RoutineEditorBody
                    key={routine?._id ?? 'new'}
                    db={db}
                    userId={userId}
                    workContexts={workContexts}
                    people={people}
                    {...(routine !== undefined ? { routine } : {})}
                    onClose={onClose}
                    onSaved={onSaved}
                    chrome="dialog"
                />
            </DialogContent>
        </Dialog>
    );
}

function RoutineReassignInFlightDialog({ onClose }: { onClose: () => void }) {
    return (
        <Dialog open onClose={onClose} fullWidth maxWidth="xs">
            <DialogTitle>Move in progress</DialogTitle>
            <DialogContent>
                <Alert severity="info" variant="outlined">
                    This routine is being moved to another account. You can edit it once the move completes.
                </Alert>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Close</Button>
            </DialogActions>
        </Dialog>
    );
}
