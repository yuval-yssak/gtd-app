import Button from '@mui/material/Button';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import { useNavigate } from '@tanstack/react-router';
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
    const navigate = useNavigate();

    if (!entry) {
        return null;
    }

    function onUndoClick() {
        startUndo(async () => {
            await runCurrentUndo();
        });
    }

    // Follow the offer's link, then dismiss so the snackbar doesn't linger over the destination.
    function onViewClick() {
        if (!entry?.link) {
            return;
        }
        // `link` is a runtime-built path (e.g. `/item/<id>`); `as never` matches AppNav's dynamic-nav pattern.
        navigate({ to: entry.link as never });
        dismissCurrentUndo();
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
                <Stack direction="row" spacing={1}>
                    {entry.link && (
                        <Button color="secondary" size="small" onClick={onViewClick} data-testid="undoSnackbarViewButton">
                            View
                        </Button>
                    )}
                    <Button color="secondary" size="small" onClick={onUndoClick} disabled={isUndoing} data-testid="undoSnackbarButton">
                        Undo
                    </Button>
                </Stack>
            }
            data-testid="undoSnackbar"
        />
    );
}
