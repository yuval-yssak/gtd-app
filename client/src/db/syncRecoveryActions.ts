import type { IDBPDatabase } from 'idb';
import { SYNC_RECOVERY_IDLE, setSyncRecoveryState } from '../contexts/syncRecoveryStore';
import { triggerAppResourceRefresh } from '../data/appResource';
import type { EntityType, MyDB } from '../types/MyDB';
import { withAccountSession } from './multiUserSync';
import { bootstrapFromServerUnguarded, flushSyncQueue } from './syncHelpers';
import { describeQueuedOp, errorMessageOf, readQueuedOpsForUser } from './syncRecovery';

/**
 * Case-2 recovery actions, invoked from SyncRecoveryDialog AFTER the sync orchestrator returned
 * (it skipped the reaped user's pass without flushing). Each action runs in ONE
 * `withAccountSession` block: the session must be pivoted to the recovering user before any server
 * call, and withAccountSession already holds the session gate — so everything inside must use the
 * UNGUARDED helpers (`bootstrapFromServerUnguarded`; `flushSyncQueue` is not session-gated at all),
 * or the nested gate acquisition would deadlock.
 */

/** "Push my offline changes": flush the queue, then full-bootstrap. HALTS (never bootstraps) on a failed flush. */
export async function pushQueuedChangesAndBootstrap(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    // Snapshot the queue BEFORE flushing so a failure can report exactly which ops were being sent.
    const opsBeingSent = await readQueuedOpsForUser(db, userId);
    const enterFlushFailed = (err: unknown) =>
        setSyncRecoveryState({
            phase: 'flushFailed',
            userId,
            queuedOpCount: opsBeingSent.length,
            errorMessage: errorMessageOf(err),
            failedOpSummaries: opsBeingSent.map(describeQueuedOp),
        });
    setSyncRecoveryState({ phase: 'flushing', userId, queuedOpCount: opsBeingSent.length });
    try {
        await withAccountSession(db, userId, async () => {
            try {
                await flushSyncQueue(db, { userIdFilter: userId });
            } catch (err) {
                // A push failure rejects the whole batch (or never reached the server) — the queue
                // is intact. NEVER auto-proceed to bootstrap here: bootstrapping would reset the
                // cursor and the un-pushed local changes would be silently overwritten as "synced".
                console.error('[sync-recovery] case-2 flush failed — halting before bootstrap', err);
                enterFlushFailed(err);
                return;
            }
            await bootstrapAndUnlock(db, userId);
        });
    } catch (err) {
        // withAccountSession itself rejected (session listing is a network call) — nothing was
        // flushed. Route to the retryable flushFailed phase; the spinner phases have no buttons,
        // so leaving `flushing` set would lock the app forever.
        console.error('[sync-recovery] case-2 push could not start', err);
        enterFlushFailed(err);
    }
}

/** "Discard & full sync": drop this user's queued ops (other users' ops untouched), then full-bootstrap. */
export function discardQueuedChangesAndBootstrap(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    return runBootstrapPhase(db, userId, async () => {
        await deleteQueuedOpsForUser(db, userId);
        await bootstrapAndUnlock(db, userId);
    });
}

/** Retry after `bootstrapFailed` — the flush/discard part already completed; only the bootstrap is re-run. */
export function retryBootstrap(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    return runBootstrapPhase(db, userId, () => bootstrapAndUnlock(db, userId));
}

/**
 * Shared shell for the actions whose visible phase is `bootstrapping`: pivots the session and
 * routes ANY escaping rejection (gate acquisition, IDB deletes) into the retryable
 * `bootstrapFailed` phase — the spinner phases render no buttons, so an uncaught rejection here
 * would otherwise lock the app forever.
 */
async function runBootstrapPhase(db: IDBPDatabase<MyDB>, userId: string, task: () => Promise<void>): Promise<void> {
    setSyncRecoveryState({ phase: 'bootstrapping', userId });
    try {
        await withAccountSession(db, userId, task);
    } catch (err) {
        console.error('[sync-recovery] case-2 recovery step failed', err);
        setSyncRecoveryState({ phase: 'bootstrapFailed', userId, errorMessage: errorMessageOf(err) });
    }
}

const ENTITY_STORE_BY_TYPE: Record<EntityType, 'items' | 'routines' | 'people' | 'workContexts'> = {
    item: 'items',
    routine: 'routines',
    person: 'people',
    workContext: 'workContexts',
};

async function deleteQueuedOpsForUser(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    const ops = await readQueuedOpsForUser(db, userId);
    // Discarded `create` ops leave behind the entity rows they wrote at capture time (offline-first
    // writes IDB before queueing). Those entities never reached the server, so the put-only
    // bootstrap that follows can neither remove nor overwrite them — delete the rows here or they
    // survive locally as visible-but-unsyncable zombies.
    const discardedCreates = ops.filter((op) => op.opType === 'create');
    await Promise.all(discardedCreates.map((op) => db.delete(ENTITY_STORE_BY_TYPE[op.entityType], op.entityId)));
    // id is always present on rows fetched from IDB; the type reflects pre-insert optionality.
    const ids = ops.flatMap((op) => (op.id === undefined ? [] : [op.id]));
    await Promise.all(ids.map((id) => db.delete('syncOperations', id)));
}

/** Bootstrap → idle → refresh the UI so bootstrapped data appears without a manual reload. */
async function bootstrapAndUnlock(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    setSyncRecoveryState({ phase: 'bootstrapping', userId });
    try {
        await bootstrapFromServerUnguarded(db, userId);
    } catch (err) {
        console.error('[sync-recovery] case-2 bootstrap failed', err);
        setSyncRecoveryState({ phase: 'bootstrapFailed', userId, errorMessage: errorMessageOf(err) });
        return;
    }
    setSyncRecoveryState(SYNC_RECOVERY_IDLE);
    triggerAppResourceRefresh('all');
}
