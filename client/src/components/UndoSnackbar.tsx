import Button from '@mui/material/Button';
import Snackbar from '@mui/material/Snackbar';
import { useSyncExternalStore, useTransition } from 'react';
import { dismissCurrentUndo, getCurrentUndo, runCurrentUndo, subscribeToUndo } from '../lib/undoStore';

/** How long the Undo affordance stays available after a save. */
export const UNDO_SNACKBAR_DURATION_MS = 6000;

/**
 * Global "Saved — UNDO" snackbar. Mounted once in the authenticated layout; any editor that
 * autosaves (or commits an explicit save) surfaces its undo through the module-level undoStore.
 */
export function UndoSnackbar() {
    const entry = useSyncExternalStore(subscribeToUndo, getCurrentUndo);
    const [isUndoing, startUndo] = useTransition();

    if (!entry) {
        return null;
    }

    function onUndoClick() {
        startUndo(async () => {
            await runCurrentUndo();
        });
    }

    return (
        <Snackbar
            // Remount per offer so a burst refresh (same key, new offerId) restarts the auto-hide timer.
            key={entry.offerId}
            open
            autoHideDuration={UNDO_SNACKBAR_DURATION_MS}
            // Clickaway must not eat the offer — the user is likely just continuing to work.
            onClose={(_, reason) => {
                if (reason !== 'clickaway') {
                    dismissCurrentUndo();
                }
            }}
            message={entry.message}
            action={
                <Button color="secondary" size="small" onClick={onUndoClick} disabled={isUndoing} data-testid="undoSnackbarButton">
                    Undo
                </Button>
            }
            data-testid="undoSnackbar"
        />
    );
}
