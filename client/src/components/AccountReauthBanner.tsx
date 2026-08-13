import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import type { IDBPDatabase } from 'idb';
import { useSyncExternalStore } from 'react';
import { dismissAccountReauth, ensureAccountReauthBridge, getReauthFlaggedUserIds, subscribeAccountReauth } from '../contexts/accountReauthEvents';
import { useAccounts } from '../hooks/useAccounts';
import { useOnline } from '../hooks/useOnline';
import type { MyDB } from '../types/MyDB';
import { staleAccountRows } from './AccountReauthDialog';

// Install the window→store bridge at import time so the shared store is fed even before any banner
// mounts (and exactly once, regardless of how many banner instances AppNav double-mounts).
ensureAccountReauthBridge();

/**
 * Surfaces accounts the sync orchestrator had to skip because they have no Better Auth multi-session
 * entry on this device (Bug B). Without this, such an account's data silently never appears here.
 * The loud, first-line surface is `AccountReauthDialog` (blocking modal at the layout root); this
 * banner is the persistent reminder that remains after the dialog is acknowledged.
 *
 * State lives in the shared `accountReauthEvents` store (flagged + dismissed userId sets), not in
 * component state, because AppNav double-mounts this banner (permanent + keepMounted temporary
 * drawer). A single shared store keeps the de-dupe and the per-session dismiss durable across both
 * instances and across breakpoint changes — per-instance state would diverge. Dismissals survive the
 * orchestrator's re-dispatch every sync cycle. Each row offers a Re-login button that drives
 * `reauthForUserId`'s OAuth redirect.
 *
 * Accounts come from `useAccounts(db)` (IDB-backed), NOT `useAppData()` — this banner mounts inside
 * AppNav, which renders OUTSIDE the AppDataProvider, so `useAppData()` would return the context
 * default (undefined) and crash on destructure.
 */
export function AccountReauthBanner({ db }: { db: IDBPDatabase<MyDB> }) {
    const { allAccounts, reauthForUserId } = useAccounts(db);
    const flaggedUserIds = useSyncExternalStore(subscribeAccountReauth, getReauthFlaggedUserIds);
    // Mirrors the dialog: Re-login is an OAuth redirect and can't work offline.
    const isOnline = useOnline();

    // Includes flagged ids with no locally-known account row (generic label) — hiding those would
    // remove every trace of the broken-sync warning. See staleAccountRows.
    const visibleAccounts = staleAccountRows(flaggedUserIds, allAccounts);
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
                        <Button color="inherit" size="small" disabled={!isOnline} onClick={() => reauthForUserId(account.id)}>
                            Re-login
                        </Button>
                    }
                >
                    {account.email === null ? 'An account needs re-login to sync.' : `Your account ${account.email} needs re-login to sync.`}
                    {!isOnline ? " You're offline — re-login needs a connection." : ''}
                </Alert>
            ))}
        </Box>
    );
}
