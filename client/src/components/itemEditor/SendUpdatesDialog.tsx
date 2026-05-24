import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';

interface SendUpdatesDialogProps {
    open: boolean;
    attendeeCount: number;
    onConfirm: (sendUpdates: 'all' | 'none') => void;
    onCancel: () => void;
}

/**
 * Confirmation dialog that intercepts the Save action on a calendar item with attendees. The
 * organizer-facing choice is whether GCal should notify attendees about the change — captured
 * here so the same decision survives offline → reconnect via the `gcalMeta` sidecar on the
 * queued sync op (Phase 4).
 */
export function SendUpdatesDialog({ open, attendeeCount, onConfirm, onCancel }: SendUpdatesDialogProps) {
    return (
        <Dialog open={open} onClose={onCancel} data-testid="sendUpdatesDialog" maxWidth="xs" fullWidth>
            <DialogTitle>Send update emails?</DialogTitle>
            <DialogContent>
                <DialogContentText>
                    This event has {attendeeCount} {attendeeCount === 1 ? 'attendee' : 'attendees'}. Send them an update?
                </DialogContentText>
            </DialogContent>
            <DialogActions>
                <Button onClick={onCancel} data-testid="sendUpdatesCancel">
                    Cancel
                </Button>
                <Button onClick={() => onConfirm('none')} data-testid="sendUpdatesNone">
                    Don't send
                </Button>
                <Button onClick={() => onConfirm('all')} variant="contained" data-testid="sendUpdatesAll">
                    Send updates
                </Button>
            </DialogActions>
        </Dialog>
    );
}
