import type { IDBPDatabase } from 'idb';
import { useSyncExternalStore } from 'react';
import { getSyncRecoveryState, type SyncRecoveryState, subscribeSyncRecovery } from '../contexts/syncRecoveryStore';
import { downloadRecoveryExports } from '../db/exportRecoveryData';
import { discardQueuedChangesAndBootstrap, pushQueuedChangesAndBootstrap, retryBootstrap } from '../db/syncRecoveryActions';
import { Button, Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle, Spinner, Text } from '../designSystem';
import type { MyDB } from '../types/MyDB';
import styles from './SyncRecoveryDialog.module.css';

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
        // No onClose on purpose: the dialog is controlled and nothing ever sets it closed, so backdrop
        // presses and Escape cannot dismiss this blocking recovery.
        <Dialog open disableBackdropClose data-testid="syncRecoveryDialog">
            <DialogTitle>Full sync required</DialogTitle>
            <PhaseContent state={state} />
            <PhaseActions state={state} db={db} />
        </Dialog>
    );
}

function SpinnerContent({ message }: { message: string }) {
    return (
        <DialogContent>
            <DialogDescription>{message}</DialogDescription>
            <div className={styles.spinnerRow}>
                <Spinner size={40} />
            </div>
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
                    <DialogDescription>
                        {STALE_DEVICE_EXPLANATION} A full sync is required, and this device has {state.queuedOpCount} unsynced local change
                        {state.queuedOpCount === 1 ? '' : 's'}. Choose what to do with {state.queuedOpCount === 1 ? 'it' : 'them'}:
                    </DialogDescription>
                </DialogContent>
            );
        case 'flushFailed':
            return (
                <DialogContent>
                    <DialogDescription className={styles.error}>Pushing your offline changes failed: {state.errorMessage}</DialogDescription>
                    <Text as="div" tone="secondary" className={styles.paragraph}>
                        The following changes were being sent:
                        <ul>
                            {state.failedOpSummaries.map((summary) => (
                                <li key={summary}>{summary}</li>
                            ))}
                        </ul>
                        Nothing was discarded. You can retry, export your data, or discard the changes and run a full sync.
                    </Text>
                </DialogContent>
            );
        case 'bootstrapFailed':
            return (
                <DialogContent>
                    <DialogDescription className={styles.error}>The full sync failed: {state.errorMessage}</DialogDescription>
                    <Text tone="secondary" className={styles.paragraph}>
                        Check your connection and retry.
                    </Text>
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
                    <Button onClick={() => run(discardQueuedChangesAndBootstrap(db, state.userId))} tone="danger" data-testid="syncRecoveryDiscard">
                        Discard &amp; full sync
                    </Button>
                    <Button onClick={() => run(pushQueuedChangesAndBootstrap(db, state.userId))} variant="solid" data-testid="syncRecoveryPush">
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
                    <Button onClick={() => run(discardQueuedChangesAndBootstrap(db, state.userId))} tone="danger" data-testid="syncRecoveryDiscard">
                        Discard &amp; full sync
                    </Button>
                    <Button onClick={() => run(pushQueuedChangesAndBootstrap(db, state.userId))} variant="solid" data-testid="syncRecoveryRetry">
                        Retry flush
                    </Button>
                </DialogActions>
            );
        case 'bootstrapFailed':
            return (
                <DialogActions>
                    <Button onClick={() => run(retryBootstrap(db, state.userId))} variant="solid" data-testid="syncRecoveryRetry">
                        Retry full sync
                    </Button>
                </DialogActions>
            );
        default:
            // Spinner phases (case1Syncing / flushing / bootstrapping): no interaction while working.
            return null;
    }
}
