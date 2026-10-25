import { X } from 'lucide-react';
import { useSyncExternalStore, useTransition } from 'react';
import { Button, IconButton, Toast } from '../designSystem';
import { isNewTabClick, useNewTabAwareNavigate } from '../lib/newTabNavigation';
import { dismissCurrentUndo, getCurrentUndo, runCurrentUndo, subscribeToUndo } from '../lib/undoStore';

/** How long the Undo affordance stays available after a save. */
export const UNDO_TOAST_DURATION_MS = 6000;

/**
 * Global "Saved — UNDO" snackbar. Mounted once in the authenticated layout; any editor that
 * autosaves (or commits an explicit save) surfaces its undo through the module-level undoStore.
 */
export function UndoToast() {
    const entry = useSyncExternalStore(subscribeToUndo, getCurrentUndo);
    const [isUndoing, startUndo] = useTransition();
    const navigateOrNewTab = useNewTabAwareNavigate();

    if (!entry) {
        return null;
    }

    function onUndoClick() {
        startUndo(async () => {
            await runCurrentUndo();
        });
    }

    // Follow the offer's link, then dismiss so the snackbar doesn't linger over the destination.
    function onViewClick(e: React.MouseEvent) {
        if (!entry?.link) {
            return;
        }
        // `link` is a runtime-built path (e.g. `/item/<id>`); `as never` matches AppNav's dynamic-nav pattern.
        navigateOrNewTab(e, { to: entry.link as never });
        // A cmd/ctrl+click opened a new tab — keep the snackbar here so Undo stays available.
        if (!isNewTabClick(e)) {
            dismissCurrentUndo();
        }
    }

    return (
        <Toast
            // Remount per offer so a burst refresh (same key, new offerId) restarts the auto-hide timer.
            key={entry.offerId}
            open
            autoHideDuration={UNDO_TOAST_DURATION_MS}
            // The toast never closes on a click elsewhere: the user is likely just continuing to work.
            onClose={dismissCurrentUndo}
            message={entry.message}
            action={
                <>
                    {entry.link && (
                        <Button size="sm" onClick={onViewClick} data-testid="undoSnackbarViewButton">
                            View
                        </Button>
                    )}
                    <Button size="sm" onClick={onUndoClick} disabled={isUndoing} data-testid="undoSnackbarButton">
                        Undo
                    </Button>
                    {/* Manual dismiss: without it the toast covers the buttons underneath for the full 6s. */}
                    <IconButton size="sm" tone="inherit" aria-label="Close" onClick={dismissCurrentUndo} data-testid="undoSnackbarCloseButton">
                        <X />
                    </IconButton>
                </>
            }
            data-testid="undoSnackbar"
        />
    );
}
