import type { IDBPDatabase } from 'idb';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle } from '../../designSystem';
import type { MyDB, StoredWorkContext } from '../../types/MyDB';
import { WorkContextEditorBody } from './WorkContextEditorBody';

interface WorkContextEditDialogProps {
    db: IDBPDatabase<MyDB>;
    workContext: StoredWorkContext;
    onClose: () => void;
}

/**
 * Dialog chrome around WorkContextEditorBody (the /work-context/$workContextId route renders the
 * same body as a full page). Fully autosaving — the dialog only offers Close. Mount-on-open: the
 * caller conditionally renders this so state re-seeds per context.
 */
export function WorkContextEditDialog({ db, workContext, onClose }: WorkContextEditDialogProps) {
    return (
        <Dialog open onClose={onClose} size="xs" fullWidth>
            <DialogTitle>Rename context</DialogTitle>
            <DialogContent>
                <WorkContextEditorBody db={db} workContext={workContext} onClose={onClose} />
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose} data-testid="workContextEditClose">
                    Close
                </Button>
            </DialogActions>
        </Dialog>
    );
}
