import { useRef } from 'react';
import { AlertDialog, Button, DialogActions, DialogDescription, DialogTitle } from '../designSystem';
import type { UnsavedChangesBlocker } from '../hooks/useUnsavedChangesGuard';

/**
 * Confirm dialog shown when a navigation is paused by `useUnsavedChangesGuard`. Dismissing it
 * (Escape) counts as "keep editing" — losing edits must always be an explicit choice.
 */
export function UnsavedChangesDialog({ blocker }: { blocker: UnsavedChangesBlocker }) {
    // The safe choice takes focus, so a reflexive Enter keeps the edits.
    const stayButtonRef = useRef<HTMLButtonElement>(null);
    return (
        <AlertDialog open={blocker.isBlocked} onClose={blocker.stay} initialFocus={stayButtonRef} size="xs" data-testid="unsavedChangesDialog">
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>You have unsaved changes on this form. If you leave now, they will be lost.</DialogDescription>
            <DialogActions>
                <Button ref={stayButtonRef} onClick={blocker.stay} data-testid="unsavedChangesStay">
                    Keep editing
                </Button>
                <Button variant="solid" tone="danger" onClick={blocker.discard} data-testid="unsavedChangesDiscard">
                    Discard and leave
                </Button>
            </DialogActions>
        </AlertDialog>
    );
}
