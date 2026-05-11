import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';

interface Props {
    onClose: () => void;
    /** Defaults to 'item' so existing call sites in the item editor stay valid without changes. */
    entityLabel?: 'item' | 'routine';
}

/**
 * Inline counterpart to the in-flight reassign Dialog — used by popover/expand/page wrappers
 * where a Dialog inside a non-Dialog parent would be visually wrong. Same intent: opening the
 * editor on an entity with an in-flight cross-account reassign would seed ownerUserId from the
 * overlayed (target) user and a save would write IDB under the target — the misroute the
 * reassign flow exists to prevent. Refuse the edit until the move resolves.
 */
export function ReassignInFlightInline({ onClose, entityLabel = 'item' }: Props) {
    return (
        <Box>
            <Alert severity="info" variant="outlined">
                This {entityLabel} is being moved to another account. You can edit it once the move completes.
            </Alert>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1.5 }}>
                <Button onClick={onClose}>Close</Button>
            </Box>
        </Box>
    );
}
