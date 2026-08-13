import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import type { IDBPDatabase } from 'idb';
import { useSyncExternalStore } from 'react';
import { acknowledgeAccountReauthDialog, ensureAccountReauthBridge, getReauthDialogUserIds, subscribeAccountReauth } from '../contexts/accountReauthEvents';
import { useAccounts } from '../hooks/useAccounts';
import { useOnline } from '../hooks/useOnline';
import type { MyDB } from '../types/MyDB';

// Install the window→store bridge at import time so a reauth flag dispatched before first render is
// not lost (idempotent — the banner module installs the same bridge).
ensureAccountReauthBridge();

export const UNKNOWN_ACCOUNT_LABEL = 'Unknown account';

/**
 * Maps every flagged userId to a display row — including ids with no locally-known account (the
 * `useAccounts` async load can lose the race against the sync orchestrator's flags, and a stale
 * flag can outlive its IDB account row). Dropping unknown ids would silently hide the very
 * warning this dialog exists to make unmissable, so they render with `email: null` and each
 * surface substitutes its own generic wording.
 */
export function staleAccountRows(flaggedUserIds: readonly string[], knownAccounts: readonly { id: string; email: string }[]) {
    const emailById = new Map(knownAccounts.map((account) => [account.id, account.email]));
    return flaggedUserIds.map((userId) => ({ id: userId, email: emailById.get(userId) ?? null }));
}

/**
 * Blocking modal counterpart of `AccountReauthBanner`. While an account can't sync (no Better Auth
 * multi-session entry on this device), the app silently shows stale data — a status-bar alert is too
 * easy to miss for that, so this dialog interrupts the whole app until the user re-logs in or
 * explicitly chooses "Not now". Dismissing it only acknowledges the *dialog* tier of the shared
 * store: the status-bar banner keeps showing as a persistent reminder. Mounted ONCE at the
 * authenticated layout root (like SyncRecoveryDialog) — it must not double-mount with AppNav's
 * drawers the way the banner does.
 */
export function AccountReauthDialog({ db }: { db: IDBPDatabase<MyDB> }) {
    const { allAccounts, reauthForUserId } = useAccounts(db);
    const dialogUserIds = useSyncExternalStore(subscribeAccountReauth, getReauthDialogUserIds);
    // Re-login is an OAuth redirect — impossible offline. An offline switch to an expired-session
    // account should show cached data + this informative (but non-actionable-while-offline) dialog.
    const isOnline = useOnline();

    const staleAccounts = staleAccountRows(dialogUserIds, allAccounts);
    if (staleAccounts.length === 0) {
        return null;
    }

    // Acknowledge the raw store snapshot, not the rendered rows — an account flagged before
    // `useAccounts` finishes loading must still be acknowledged, or the dialog re-opens on its own
    // once the account list arrives.
    const acknowledgeAll = () => {
        for (const userId of dialogUserIds) {
            acknowledgeAccountReauthDialog(userId);
        }
    };

    return (
        // Escape / backdrop click behave like "Not now": the dialog closes but the status-bar banner
        // stays, so the warning never disappears entirely without an explicit banner dismissal.
        <Dialog open onClose={acknowledgeAll} data-testid="accountReauthDialog">
            <DialogTitle>Sync is broken for {staleAccounts.length === 1 ? 'an account' : 'some accounts'}</DialogTitle>
            <DialogContent>
                <DialogContentText sx={{ mb: 2 }}>
                    The data shown for {staleAccounts.length === 1 ? 'this account' : 'these accounts'} may be stale or incomplete until you log in again —
                    changes are not syncing.
                </DialogContentText>
                {!isOnline && (
                    <DialogContentText sx={{ mb: 2 }} data-testid="accountReauthDialogOfflineHint">
                        You're offline — re-login needs a connection. You can keep working with the cached data shown.
                    </DialogContentText>
                )}
                <Stack spacing={1}>
                    {staleAccounts.map((account) => (
                        <Alert
                            key={account.id}
                            severity="warning"
                            action={
                                <Button
                                    color="inherit"
                                    size="small"
                                    disabled={!isOnline}
                                    onClick={() => reauthForUserId(account.id)}
                                    data-testid="accountReauthDialogRelogin"
                                >
                                    Re-login
                                </Button>
                            }
                        >
                            {account.email ?? UNKNOWN_ACCOUNT_LABEL}
                        </Alert>
                    ))}
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button onClick={acknowledgeAll} data-testid="accountReauthDialogNotNow">
                    Not now
                </Button>
            </DialogActions>
        </Dialog>
    );
}
