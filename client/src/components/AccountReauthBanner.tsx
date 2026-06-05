import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import type { IDBPDatabase } from 'idb';
import { useSyncExternalStore } from 'react';
import { useAppData } from '../contexts/AppDataProvider';
import { dismissAccountReauth, ensureAccountReauthBridge, getReauthFlaggedUserIds, subscribeAccountReauth } from '../contexts/accountReauthEvents';
import { useAccounts } from '../hooks/useAccounts';
import type { MyDB } from '../types/MyDB';

// Install the window→store bridge at import time so the shared store is fed even before any banner
// mounts (and exactly once, regardless of how many banner instances AppNav double-mounts).
ensureAccountReauthBridge();

/**
 * Surfaces accounts the sync orchestrator had to skip because they have no Better Auth multi-session
 * entry on this device (Bug B). Without this, such an account's data silently never appears here.
 *
 * State lives in the shared `accountReauthEvents` store (flagged + dismissed userId sets), not in
 * component state, because AppNav double-mounts this banner (permanent + keepMounted temporary
 * drawer). A single shared store keeps the de-dupe and the per-session dismiss durable across both
 * instances and across breakpoint changes — per-instance state would diverge. Dismissals survive the
 * orchestrator's re-dispatch every sync cycle. Each row offers a Re-login button that drives
 * `reauthForUserId`'s OAuth redirect.
 */
export function AccountReauthBanner({ db }: { db: IDBPDatabase<MyDB> }) {
    const { loggedInAccounts } = useAppData();
    const { reauthForUserId } = useAccounts(db);
    const flaggedUserIds = useSyncExternalStore(subscribeAccountReauth, getReauthFlaggedUserIds);

    // Render only accounts that are flagged AND known locally (so we can show an email).
    const flagged = new Set(flaggedUserIds);
    const visibleAccounts = loggedInAccounts.filter((a) => flagged.has(a.id));
    if (visibleAccounts.length === 0) {
        return null;
    }

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, width: '100%' }}>
            {visibleAccounts.map((account) => (
                <Alert
                    key={account.id}
                    severity="warning"
                    onClose={() => dismissAccountReauth(account.id)}
                    action={
                        <Button color="inherit" size="small" onClick={() => reauthForUserId(account.id)}>
                            Re-login
                        </Button>
                    }
                >
                    Your account {account.email} needs re-login to sync.
                </Alert>
            ))}
        </Box>
    );
}
