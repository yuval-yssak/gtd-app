import type { IDBPDatabase } from 'idb';
import { fetchDeviceStatus } from '#api/syncClient';
import { enterCase2Recovery, getSyncRecoveryState, SYNC_RECOVERY_IDLE, setSyncRecoveryState } from '../contexts/syncRecoveryStore';
import { triggerAppResourceRefresh } from '../data/appResource';
import type { MyDB, SyncOperation } from '../types/MyDB';
import { getOrCreateDeviceId } from './deviceId';
import { bootstrapFromServer, bootstrapFromServerUnguarded } from './syncHelpers';

/**
 * Recovery entry points for the reaped-device flow (server 409 `bootstrapRequired`, or the
 * probe-before-flush detecting `registered: false`). Case routing lives here; the Case-2 dialog
 * actions (push / discard / retry) live in `syncRecoveryActions.ts` — they run outside the sync
 * orchestrator and need `withAccountSession`, which this module must not import (multiUserSync
 * imports this module, and a two-way import would create a cycle).
 */

export async function readQueuedOpsForUser(db: IDBPDatabase<MyDB>, userId: string): Promise<SyncOperation[]> {
    const all = await db.getAll('syncOperations');
    return all.filter((op) => op.userId === userId);
}

export async function countQueuedOpsForUser(db: IDBPDatabase<MyDB>, userId: string): Promise<number> {
    return (await readQueuedOpsForUser(db, userId)).length;
}

/** One human-readable line per queued op, e.g. `create item: "Buy milk"` — used by exports + the flush-failure dialog. */
export function describeQueuedOp(op: SyncOperation): string {
    const label = op.snapshot && ('title' in op.snapshot ? op.snapshot.title : op.snapshot.name);
    return label ? `${op.opType} ${op.entityType}: "${label}"` : `${op.opType} ${op.entityType} ${op.entityId}`;
}

/**
 * Probe: true when the server has no deviceSyncState row for this device (it was reaped). A probe
 * failure (network / auth) reads as "registered" — sync must not be blocked on the probe endpoint's
 * availability; a genuinely-reaped device is still caught by the pull's 409 belt-and-suspenders.
 */
export async function isDeviceUnregistered(db: IDBPDatabase<MyDB>): Promise<boolean> {
    try {
        const deviceId = await getOrCreateDeviceId(db);
        const { registered } = await fetchDeviceStatus(deviceId);
        return !registered;
    } catch (err) {
        console.warn('[sync-recovery] device-status probe failed — proceeding with normal flush+pull', err);
        return false;
    }
}

/**
 * Routes a pull-time BootstrapRequiredError for callers that do NOT hold the session gate (SSE
 * per-user pull in AppDataProvider). Case 1 bootstraps through the gated `bootstrapFromServer`.
 */
export function recoverFromBootstrapRequired(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    return routeBootstrapRequired(db, userId, () => bootstrapFromServer(db, userId));
}

/**
 * Same routing for callers already INSIDE the session gate (the orchestrator's `syncOneUser`).
 * Uses the unguarded bootstrap — the gated one would recurse into the gate the caller holds and
 * deadlock (see the recursion comments on `pullOrBootstrap` in multiUserSync.ts).
 */
export function recoverFromBootstrapRequiredUnderGate(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    return routeBootstrapRequired(db, userId, () => bootstrapFromServerUnguarded(db, userId));
}

/**
 * Case split on the queued-op count:
 * - ops queued → Case 2: surface the choice dialog; the user (not code) decides push vs discard.
 * - queue empty → Case 1: lock the app behind the dialog spinner and auto-bootstrap. A bootstrap
 *   failure lands in `bootstrapFailed` (with retry) rather than leaving the app locked forever.
 */
async function routeBootstrapRequired(db: IDBPDatabase<MyDB>, userId: string, runBootstrap: () => Promise<void>): Promise<void> {
    const queuedOpCount = await countQueuedOpsForUser(db, userId);
    if (queuedOpCount > 0) {
        // A pull 409'd even though the probe said registered (probe raced a reap) — same Case-2
        // treatment: nothing was flushed for this pass, so the user's choice is still meaningful.
        enterCase2Recovery(userId, queuedOpCount);
        return;
    }
    if (getSyncRecoveryState().phase !== 'idle') {
        // Another account's recovery is already on screen — don't clobber it; this account is
        // re-detected on the next sync pass.
        return;
    }
    setSyncRecoveryState({ phase: 'case1Syncing', userId });
    try {
        await runBootstrap();
        setSyncRecoveryState(SYNC_RECOVERY_IDLE);
        // Show the freshly bootstrapped data without requiring a manual reload.
        triggerAppResourceRefresh('all');
    } catch (err) {
        console.error('[sync-recovery] case-1 auto-bootstrap failed', err);
        setSyncRecoveryState({ phase: 'bootstrapFailed', userId, errorMessage: errorMessageOf(err) });
    }
}

export function errorMessageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
