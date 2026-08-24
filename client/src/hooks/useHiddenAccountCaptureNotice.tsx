import Button from '@mui/material/Button';
import Snackbar from '@mui/material/Snackbar';
import { useState } from 'react';
import { getHiddenAccountIds, toggleAccountHidden } from '../contexts/hiddenAccounts';

/**
 * Shared "captured into a hidden account" notice. Captures always land in the active account, but
 * the account-visibility toggles are display-only — when the active account is hidden the new item
 * vanishes from every list with no other signal, so every capture surface (inbox field, quick-
 * capture FAB) raises this snackbar with a "Show account" escape hatch.
 */
export function useHiddenAccountCaptureNotice() {
    const [hiddenCaptureUserId, setHiddenCaptureUserId] = useState<string | null>(null);

    function noticeCaptureIfHidden(userId: string) {
        if (getHiddenAccountIds().includes(userId)) {
            setHiddenCaptureUserId(userId);
        }
    }

    function onShowHiddenAccount() {
        // Guarded: the account may have been un-hidden via the nav toggle row while this snackbar
        // was open — toggleAccountHidden is symmetric, so an unguarded call would hide it right back.
        if (hiddenCaptureUserId && getHiddenAccountIds().includes(hiddenCaptureUserId)) {
            toggleAccountHidden(hiddenCaptureUserId);
        }
        setHiddenCaptureUserId(null);
    }

    const hiddenAccountNotice = (
        <Snackbar
            open={hiddenCaptureUserId !== null}
            autoHideDuration={8000}
            // Default bottom-left anchor sits directly on top of the account visibility toggle
            // row in the nav drawer footer — bottom-center avoids covering the control the user
            // needs to click (same reasoning as AccountSwitcher's own error snackbar).
            anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
            onClose={(_, reason) => {
                if (reason !== 'clickaway') {
                    setHiddenCaptureUserId(null);
                }
            }}
            message="Item captured, but its account is hidden — you won't see it until you show that account again"
            action={
                <Button color="secondary" size="small" onClick={onShowHiddenAccount} data-testid="showHiddenAccountButton">
                    Show account
                </Button>
            }
            data-testid="hiddenAccountCaptureSnackbar"
        />
    );

    return { noticeCaptureIfHidden, hiddenAccountNotice };
}
