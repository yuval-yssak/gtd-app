import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import type { IDBPDatabase } from 'idb';
import type { MyDB, StoredPerson } from '../../types/MyDB';
import { PersonEditorBody } from './PersonEditorBody';

interface PersonEditDialogProps {
    db: IDBPDatabase<MyDB>;
    person: StoredPerson;
    /** See PersonEditorBody — surfaces the account picker on multi-account devices. */
    showAccountPicker?: boolean;
    onClose: () => void;
}

/**
 * Dialog chrome around PersonEditorBody (the /person/$personId route renders the same body as a
 * full page). Fully autosaving — the dialog only offers Close. Mount-on-open, like before:
 * callers conditionally render this component so the form state re-seeds per person.
 */
export function PersonEditDialog({ db, person, showAccountPicker = false, onClose }: PersonEditDialogProps) {
    return (
        <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
            <DialogTitle>Edit person</DialogTitle>
            <DialogContent>
                <PersonEditorBody db={db} person={person} showAccountPicker={showAccountPicker} onClose={onClose} />
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose} data-testid="personEditClose">
                    Close
                </Button>
            </DialogActions>
        </Dialog>
    );
}
