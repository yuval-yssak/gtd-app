import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import type { IDBPDatabase } from 'idb';
import { usePendingReassign } from '../contexts/PendingReassignProvider';
import type { MyDB, StoredItem, StoredPerson, StoredWorkContext } from '../types/MyDB';
import styles from './EditItemDialog.module.css';
import type { EditableStatus } from './editItemDialogLogic';
import { CopyIdButton } from './itemEditor/CopyIdButton';
import { ItemEditorBody } from './itemEditor/ItemEditorBody';

interface Props {
    item: StoredItem;
    db: IDBPDatabase<MyDB>;
    people: StoredPerson[];
    workContexts: StoredWorkContext[];
    onClose: () => void;
    onSaved: () => Promise<void>;
    /** Pre-selects a status chip on open — used by inbox chip clicks (e.g. "Calendar" pre-selected). */
    initialStatus?: EditableStatus;
    /** Forwarded to ItemEditorBody — fires when a done-transition on a fromGmail item completes. */
    onFromGmailReadOnly?: () => void;
}

/**
 * Thin Dialog wrapper around ItemEditorBody. Short-circuits to ReassignInFlightDialog when a
 * cross-account move is mid-flight on this entity — opening the body in that state would seed
 * ownerUserId from the overlayed (target) user and a save would write IDB under the target,
 * which is the precise misroute the reassign flow exists to prevent.
 *
 * The body's local state is keyed off `item._id` so opening the dialog on a different item
 * forces a remount and form-state reset.
 */
export function EditItemDialog({ item, db, people, workContexts, onClose, onSaved, initialStatus, onFromGmailReadOnly }: Props) {
    const { isPending } = usePendingReassign();
    if (isPending('item', item._id)) {
        return <ReassignInFlightDialog onClose={onClose} />;
    }
    return (
        <Dialog open onClose={onClose} fullWidth maxWidth="sm">
            <DialogTitle className={styles.dialogTitle}>
                <span>Edit item</span>
                <CopyIdButton id={item._id} />
            </DialogTitle>
            <DialogContent className={styles.dialogContent}>
                <ItemEditorBody
                    item={item}
                    db={db}
                    people={people}
                    workContexts={workContexts}
                    onClose={onClose}
                    onSaved={onSaved}
                    chrome="dialog"
                    {...(initialStatus ? { initialStatus } : {})}
                    {...(onFromGmailReadOnly ? { onFromGmailReadOnly } : {})}
                />
            </DialogContent>
        </Dialog>
    );
}

function ReassignInFlightDialog({ onClose }: { onClose: () => void }) {
    return (
        <Dialog open onClose={onClose} fullWidth maxWidth="xs">
            <DialogTitle>Move in progress</DialogTitle>
            <DialogContent>
                <Alert severity="info" variant="outlined">
                    This item is being moved to another account. You can edit it once the move completes.
                </Alert>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Close</Button>
            </DialogActions>
        </Dialog>
    );
}
