import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import type { IDBPDatabase } from 'idb';
import { useSyncExternalStore } from 'react';
import { getSyncRecoveryState, type SyncRecoveryState, subscribeSyncRecovery } from '../contexts/syncRecoveryStore';
import { downloadRecoveryExports } from '../db/exportRecoveryData';
import { discardQueuedChangesAndBootstrap, pushQueuedChangesAndBootstrap, retryBootstrap } from '../db/syncRecoveryActions';
import type { MyDB } from '../types/MyDB';

/**
 * Blocking recovery dialog for a device the server reaped after >30 days offline (sync pull → 409
 * bootstrapRequired). No backdrop-click / Escape dismissal and no close button — the app is locked
 * until recovery completes (or the user makes an explicit Case-2 choice). Driven entirely by the
 * module-level syncRecoveryStore; mounted once in the authenticated layout.
 */
export function SyncRecoveryDialog({ db }: { db: IDBPDatabase<MyDB> }) {
    const state = useSyncExternalStore(subscribeSyncRecovery, getSyncRecoveryState);
    if (state.phase === 'idle') {
        return null;
    }
    return (
        // No onClose on purpose: with no close handler, backdrop clicks and Escape have nothing to
        // call, so they cannot dismiss this blocking recovery (MUI v9 removed disableEscapeKeyDown).
        <Dialog open data-testid="syncRecoveryDialog">
            <DialogTitle>Full sync required</DialogTitle>
            <PhaseContent state={state} />
            <PhaseActions state={state} db={db} />
        </Dialog>
    );
}

function SpinnerContent({ message }: { message: string }) {
    return (
        <DialogContent>
            <DialogContentText>{message}</DialogContentText>
            {/* sx: layout-only centering for the progress spinner */}
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
                <CircularProgress />
            </Box>
        </DialogContent>
    );
}

const STALE_DEVICE_EXPLANATION = "This device hasn't synced in over 30 days, so its local sync state is out of date.";

function PhaseContent({ state }: { state: Exclude<SyncRecoveryState, { phase: 'idle' }> }) {
    switch (state.phase) {
        case 'case1Syncing':
            return <SpinnerContent message={`${STALE_DEVICE_EXPLANATION} Running a full sync now — this may take a moment.`} />;
        case 'flushing':
            return <SpinnerContent message={`Pushing your ${state.queuedOpCount} offline change${state.queuedOpCount === 1 ? '' : 's'} to the server…`} />;
        case 'bootstrapping':
            return <SpinnerContent message="Running a full sync…" />;
        case 'case2Choice':
            return (
                <DialogContent>
                    <DialogContentText>
                        {STALE_DEVICE_EXPLANATION} A full sync is required, and this device has {state.queuedOpCount} unsynced local change
                        {state.queuedOpCount === 1 ? '' : 's'}. Choose what to do with {state.queuedOpCount === 1 ? 'it' : 'them'}:
                    </DialogContentText>
                </DialogContent>
            );
        case 'flushFailed':
            return (
                <DialogContent>
                    <DialogContentText color="error">Pushing your offline changes failed: {state.errorMessage}</DialogContentText>
                    <DialogContentText component="div">
                        The following changes were being sent:
                        <ul>
                            {state.failedOpSummaries.map((summary) => (
                                <li key={summary}>{summary}</li>
                            ))}
                        </ul>
                        Nothing was discarded. You can retry, export your data, or discard the changes and run a full sync.
                    </DialogContentText>
                </DialogContent>
            );
        case 'bootstrapFailed':
            return (
                <DialogContent>
                    <DialogContentText color="error">The full sync failed: {state.errorMessage}</DialogContentText>
                    <DialogContentText>Check your connection and retry.</DialogContentText>
                </DialogContent>
            );
    }
}

function PhaseActions({ state, db }: { state: Exclude<SyncRecoveryState, { phase: 'idle' }>; db: IDBPDatabase<MyDB> }) {
    // Recovery actions report failures through the store (flushFailed / bootstrapFailed); a rejection
    // here means the action couldn't even start (e.g. session listing failed) — log, don't crash.
    const run = (action: Promise<void>) => void action.catch((err) => console.error('[sync-recovery] action failed', err));
    switch (state.phase) {
        case 'case2Choice':
            return (
                <DialogActions>
                    <Button onClick={() => run(downloadRecoveryExports(db, state.userId))} data-testid="syncRecoveryExport">
                        Export
                    </Button>
                    <Button onClick={() => run(discardQueuedChangesAndBootstrap(db, state.userId))} color="error" data-testid="syncRecoveryDiscard">
                        Discard &amp; full sync
                    </Button>
                    <Button onClick={() => run(pushQueuedChangesAndBootstrap(db, state.userId))} variant="contained" data-testid="syncRecoveryPush">
                        Push my offline changes
                    </Button>
                </DialogActions>
            );
        case 'flushFailed':
            return (
                <DialogActions>
                    <Button onClick={() => run(downloadRecoveryExports(db, state.userId))} data-testid="syncRecoveryExport">
                        Export
                    </Button>
                    <Button onClick={() => run(discardQueuedChangesAndBootstrap(db, state.userId))} color="error" data-testid="syncRecoveryDiscard">
                        Discard &amp; full sync
                    </Button>
                    <Button onClick={() => run(pushQueuedChangesAndBootstrap(db, state.userId))} variant="contained" data-testid="syncRecoveryRetry">
                        Retry flush
                    </Button>
                </DialogActions>
            );
        case 'bootstrapFailed':
            return (
                <DialogActions>
                    <Button onClick={() => run(retryBootstrap(db, state.userId))} variant="contained" data-testid="syncRecoveryRetry">
                        Retry full sync
                    </Button>
                </DialogActions>
            );
        default:
            // Spinner phases (case1Syncing / flushing / bootstrapping): no interaction while working.
            return null;
    }
}
