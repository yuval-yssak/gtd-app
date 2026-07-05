import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import type { UnsavedChangesBlocker } from '../hooks/useUnsavedChangesGuard';

/**
 * Confirm dialog shown when a navigation is paused by `useUnsavedChangesGuard`. Dismissing it
 * (backdrop / Escape) counts as "keep editing" — losing edits must always be an explicit choice.
 */
export function UnsavedChangesDialog({ blocker }: { blocker: UnsavedChangesBlocker }) {
    return (
        <Dialog open={blocker.isBlocked} onClose={blocker.stay} data-testid="unsavedChangesDialog">
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogContent>
                <DialogContentText>You have unsaved changes on this form. If you leave now, they will be lost.</DialogContentText>
            </DialogContent>
            <DialogActions>
                <Button onClick={blocker.stay} autoFocus data-testid="unsavedChangesStay">
                    Keep editing
                </Button>
                <Button onClick={blocker.discard} color="error" data-testid="unsavedChangesDiscard">
                    Discard and leave
                </Button>
            </DialogActions>
        </Dialog>
    );
}
