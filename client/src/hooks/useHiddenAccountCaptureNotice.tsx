import { useState } from 'react';
import { getHiddenAccountIds, toggleAccountHidden } from '../contexts/hiddenAccounts';
import { Button, Toast } from '../designSystem';

/**
 * Shared "captured into a hidden account" notice. Captures always land in the active account, but
 * the account-visibility toggles are display-only — when the active account is hidden the new item
 * vanishes from every list with no other signal, so every capture surface (inbox field, quick-
 * capture FAB) raises this notice with a "Show account" escape hatch.
 */
export function useHiddenAccountCaptureNotice() {
    const [hiddenCaptureUserId, setHiddenCaptureUserId] = useState<string | null>(null);

    function noticeCaptureIfHidden(userId: string) {
        if (getHiddenAccountIds().includes(userId)) {
            setHiddenCaptureUserId(userId);
        }
    }

    function onShowHiddenAccount() {
        // Guarded: the account may have been un-hidden via the nav toggle row while this notice
        // was open — toggleAccountHidden is symmetric, so an unguarded call would hide it right back.
        if (hiddenCaptureUserId && getHiddenAccountIds().includes(hiddenCaptureUserId)) {
            toggleAccountHidden(hiddenCaptureUserId);
        }
        setHiddenCaptureUserId(null);
    }

    const hiddenAccountNotice = (
        <Toast
            open={hiddenCaptureUserId !== null}
            autoHideDuration={8000}
            onClose={() => setHiddenCaptureUserId(null)}
            // Centred, not bottom-start: at the start edge it would cover the sidebar's account
            // visibility toggles — the very controls this notice is about.
            placement="center"
            message="Item captured, but its account is hidden — you won't see it until you show that account again"
            action={
                <Button tone="neutral" size="sm" onClick={onShowHiddenAccount} data-testid="showHiddenAccountButton">
                    Show account
                </Button>
            }
            data-testid="hiddenAccountCaptureSnackbar"
        />
    );

    return { noticeCaptureIfHidden, hiddenAccountNotice };
}
