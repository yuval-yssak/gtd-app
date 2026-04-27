import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import type { ServerOp } from '#api/syncClient';
import { fetchBootstrap, fetchSyncOps, pushSyncOps } from '#api/syncClient';
import { hasAtLeastOne } from '../lib/typeUtils';
import type { EntityType, MyDB, OpType, StoredEntity, StoredItem, StoredPerson, StoredRoutine, StoredWorkContext, SyncOperation } from '../types/MyDB';
import { getLastSyncedTs, getOrCreateDeviceId, setLastSyncedTs } from './deviceId';
import { bulkPutItems, deleteItemById, putItem } from './itemHelpers';
import { deletePersonById, putPerson } from './personHelpers';
import { deleteRoutineById, putRoutine } from './routineHelpers';
import { deleteWorkContextById, putWorkContext } from './workContextHelpers';

export interface SyncOpParams {
    opType: OpType;
    entityType: EntityType;
    entityId: string;
    // Snapshot of the entity at the moment of the change; null for deletes.
    // Stored at queue-time so flush can send it directly without re-reading IndexedDB.
    snapshot: StoredEntity | null;
}

function remapUser<T extends Record<string, unknown>>(doc: T & { user: string }) {
    const { user, ...rest } = doc;
    return { ...rest, userId: user } as Omit<T, 'user'> & { userId: string };
}

// Update the snapshot on the pending 'create' rather than adding a second op.
// The single create will carry the latest state to the server.
async function mergeUpdateIntoCreate(db: IDBPDatabase<MyDB>, existing: SyncOperation[], op: SyncOpParams) {
    // id is always present on records fetched from IDB; the type reflects pre-insert optionality
    const pendingCreates = existing.filter((q): q is SyncOperation & { id: number } => q.opType === 'create' && q.id !== undefined);
    // Invariant: at most one pending create per entity. Extra creates would be a queue
    // corruption bug — ignore them to avoid producing duplicate server creates.
    if (!hasAtLeastOne(pendingCreates)) return;
    const [queued] = pendingCreates;
    await db.delete('syncOperations', queued.id);
    await db.add('syncOperations', {
        opType: 'create',
        entityType: op.entityType,
        entityId: op.entityId,
        queuedAt: queued.queuedAt,
        snapshot: op.snapshot,
    });
}

async function clearExistingOps(db: IDBPDatabase<MyDB>, existing: SyncOperation[]) {
    // id is always present on records fetched from IDB; the type reflects pre-insert optionality
    const withId = existing.filter((q): q is SyncOperation & { id: number } => q.id !== undefined);
    await Promise.all(withId.map((q) => db.delete('syncOperations', q.id)));
}

// Background Sync API isn't in the standard TS DOM lib — cast through unknown.
// Chrome/Edge only; Safari/Firefox fall back to the immediate flush in queueSyncOp.
function registerBackgroundSync(): void {
    if (!('serviceWorker' in navigator) || !('sync' in ServiceWorkerRegistration.prototype)) {
        return;
    }
    navigator.serviceWorker.ready
        .then((reg) => (reg as unknown as { sync: { register(tag: string): Promise<void> } }).sync.register('gtd-sync-queue'))
        .catch((e) => console.error('Failed to register background sync', e));
}

export async function queueSyncOp(db: IDBPDatabase<MyDB>, op: SyncOpParams): Promise<void> {
    const { opType, entityType, entityId, snapshot } = op;
    const existing = (await db.getAll('syncOperations')).filter((q) => q.entityId === entityId);
    const hasPendingCreate = existing.some((q) => q.opType === 'create');

    if (opType === 'update' && hasPendingCreate) {
        await mergeUpdateIntoCreate(db, existing, op);
        return;
    }

    if (opType === 'delete') {
        // Collapse all prior ops. If a 'create' was pending, the item never reached the server — drop everything.
        await clearExistingOps(db, existing);
        if (hasPendingCreate) {
            return;
        }
    }

    await db.add('syncOperations', { opType, entityType, entityId, queuedAt: dayjs().toISOString(), snapshot });

    // Attempt an immediate flush. Safari and Firefox don't support the Background Sync API,
    // so without this the op would sit in IDB until the next mount or online event.
    // Fire-and-forget — errors are non-fatal; the online handler and mount effect will retry.
    void flushSyncQueue(db).catch((e) => console.warn('Failed to flush sync queue after adding op', e));
    registerBackgroundSync();
}

// Module-level guard so concurrent callers (queueSyncOp fire-and-forget, mount effect,
// online handler, service worker message) collapse into a single in-flight POST.
// Without this, two simultaneous flushes read the same queued ops and POST them twice,
// causing the server to send duplicate push notifications for the same change.
let flushInFlight: Promise<void> | null = null;

/** Wait for any in-flight sync flush to complete. Returns immediately if no flush is running. */
export function waitForPendingFlush(): Promise<void> {
    return flushInFlight ?? Promise.resolve();
}

export function flushSyncQueue(db: IDBPDatabase<MyDB>): Promise<void> {
    if (flushInFlight) return flushInFlight;
    flushInFlight = doFlush(db).finally(() => {
        flushInFlight = null;
    });
    return flushInFlight;
}

// Cross-context flush lock: the main thread and Service Worker each have their own
// module-level flushInFlight guard, so they can race and POST the same ops twice.
// This IDB-based lock coordinates across JS contexts via the shared deviceSyncState record.
const FLUSH_LOCK_TTL_MS = 30_000;

type AcquireLockResult = 'acquired' | 'noDeviceState' | 'heldByOther';

// Uses a single readwrite transaction so the check-then-set is atomic — IDB serializes
// overlapping readwrite transactions on the same store, preventing TOCTOU races.
async function acquireFlushLock(db: IDBPDatabase<MyDB>): Promise<AcquireLockResult> {
    const tx = db.transaction('deviceSyncState', 'readwrite');
    const store = tx.objectStore('deviceSyncState');
    const state = await store.get('local');
    if (!state) {
        // No device state yet — can't write a lock. No deviceId means pushSyncOps
        // would fail anyway, so skipping is safe.
        return 'noDeviceState';
    }
    if (state.flushingTs) {
        const elapsed = dayjs().diff(dayjs(state.flushingTs));
        if (elapsed < FLUSH_LOCK_TTL_MS) {
            return 'heldByOther';
        }
    }
    await store.put({ ...state, flushingTs: dayjs().toISOString() });
    await tx.done;
    return 'acquired';
}

async function releaseFlushLock(db: IDBPDatabase<MyDB>): Promise<void> {
    const tx = db.transaction('deviceSyncState', 'readwrite');
    const store = tx.objectStore('deviceSyncState');
    const state = await store.get('local');
    if (state) {
        await store.put({ ...state, flushingTs: null });
    }
    await tx.done;
}

async function doFlush(db: IDBPDatabase<MyDB>): Promise<void> {
    const lockResult = await acquireFlushLock(db);
    if (lockResult === 'heldByOther') {
        console.log('[sync-flush] skipping — another context holds the flush lock');
        return;
    }
    if (lockResult === 'noDeviceState') {
        return;
    }
    try {
        // Loop until empty: a fire-and-forget flush from queueSyncOp may have started before
        // a subsequent mutation added more ops. Without the loop, those late-arriving ops
        // stay in IDB because the in-flight flush already read its batch before they existed.
        while (true) {
            const ops = await db.getAll('syncOperations');
            if (!ops.length) {
                return;
            }

            console.log(
                `[sync-flush] pushing ${ops.length} ops to server`,
                ops.map((op) => `${op.opType}:${op.entityType}:${op.entityId}`),
            );

            const deviceId = await getOrCreateDeviceId(db);
            await pushSyncOps(deviceId, ops);

            console.log(`[sync-flush] push succeeded, removed ${ops.length} ops from queue`);

            // Batch succeeded — remove all sent ops. If the request failed, they stay for retry.
            for (const op of ops) {
                if (op.id !== undefined) {
                    await db.delete('syncOperations', op.id);
                }
            }
        }
    } finally {
        await releaseFlushLock(db).catch((e) => console.warn('[sync-flush] failed to release flush lock', e));
    }
}

// bootstrapFromServer performs a full entity snapshot hydration for new devices.
// New devices cannot rely on /sync/pull because historical operations may have been purged
// before the device registered. Bootstrap reads from entity collections (permanent ground truth)
// and sets lastSyncedTs = serverTs so the device starts incremental pull from now, not epoch.
export async function bootstrapFromServer(db: IDBPDatabase<MyDB>): Promise<void> {
    const deviceId = await getOrCreateDeviceId(db);

    const { items, routines, people, workContexts, serverTs } = await fetchBootstrap();

    const mappedItems = items.map((doc) => remapUser(doc) as unknown as StoredItem);
    const mappedRoutines = routines.map((doc) => remapUser(doc) as unknown as StoredRoutine);
    const mappedPeople = people.map((doc) => remapUser(doc) as unknown as StoredPerson);
    const mappedWorkContexts = workContexts.map((doc) => remapUser(doc) as unknown as StoredWorkContext);

    await bulkPutItems(db, mappedItems);

    const routinesTx = db.transaction('routines', 'readwrite');
    await Promise.all([...mappedRoutines.map((r) => routinesTx.store.put(r)), routinesTx.done]);

    const peopleTx = db.transaction('people', 'readwrite');
    await Promise.all([...mappedPeople.map((p) => peopleTx.store.put(p)), peopleTx.done]);

    const workContextsTx = db.transaction('workContexts', 'readwrite');
    await Promise.all([...mappedWorkContexts.map((wc) => workContextsTx.store.put(wc)), workContextsTx.done]);

    // Register device cursor at serverTs — skips replaying all historical ops since bootstrap
    // already gives us the current snapshot; incremental pull takes over from here.
    await db.put('deviceSyncState', { _id: 'local', deviceId, lastSyncedTs: serverTs, flushingTs: null });
}

// Module-level guard so concurrent callers (SSE callback and SW-message handler arriving
// for the same server change) collapse into a single in-flight pull. Without this, two
// simultaneous pulls can race on setLastSyncedTs and cause one of them to advance the
// cursor past ops the other hasn't applied yet, silently dropping changes.
let pullInFlight: Promise<void> | null = null;

export function pullFromServer(db: IDBPDatabase<MyDB>) {
    if (pullInFlight) return pullInFlight;
    pullInFlight = doPull(db).finally(() => (pullInFlight = null));
    return pullInFlight;
}

/** Wait for any in-flight pull to settle, then start a guaranteed-fresh pull.
 *  Sets pullInFlight directly so no SSE-triggered pull can slip in between the
 *  await and the new pull (JS microtask ordering guarantees no gap). */
export async function forcePull(db: IDBPDatabase<MyDB>): Promise<void> {
    if (pullInFlight) await pullInFlight;
    pullInFlight = doPull(db).finally(() => (pullInFlight = null));
    return pullInFlight;
}

/**
 * Fetches and applies server operations from the sync endpoint.
 * Must not run concurrently — call through `pullFromServer()` which provides a guard.
 * Parallel runs can race on `setLastSyncedTs` and silently drop ops from one run.
 */
async function doPull(db: IDBPDatabase<MyDB>): Promise<void> {
    const deviceId = await getOrCreateDeviceId(db);
    const since = await getLastSyncedTs(db);
    const { ops, serverTs } = await fetchSyncOps(since, deviceId);

    console.log(
        `[debug-gcal-sync][client] doPull | since=${since ?? 'epoch'} serverTs=${serverTs} opCount=${ops.length}`,
        ops.map((op) => `${op.opType}:${op.entityType}:${op.entityId}@${(op.snapshot as { updatedTs?: string } | null)?.updatedTs ?? 'n/a'}`),
    );

    for (const op of ops) {
        await applyServerOp(db, op);
    }

    await setLastSyncedTs(db, serverTs);
}

// Handlers for each entity type used by applyEntityOp to stay DRY across entity types.
// Each entry provides the three DB operations needed to apply a server op.
interface EntityApplyHandlers {
    getExisting: (id: string) => Promise<{ updatedTs: string } | undefined>;
    put: (entity: unknown) => Promise<void>;
    remove: (id: string) => Promise<void>;
}

function buildEntityHandlers(db: IDBPDatabase<MyDB>): Record<EntityType, EntityApplyHandlers> {
    return {
        item: {
            getExisting: (id) => db.get('items', id),
            put: (e) => putItem(db, e as StoredItem),
            remove: (id) => deleteItemById(db, id),
        },
        routine: {
            getExisting: (id) => db.get('routines', id),
            put: (e) => putRoutine(db, e as StoredRoutine),
            remove: (id) => deleteRoutineById(db, id),
        },
        person: {
            getExisting: (id) => db.get('people', id),
            put: (e) => putPerson(db, e as StoredPerson),
            remove: (id) => deletePersonById(db, id),
        },
        workContext: {
            getExisting: (id) => db.get('workContexts', id),
            put: (e) => putWorkContext(db, e as StoredWorkContext),
            remove: (id) => deleteWorkContextById(db, id),
        },
    };
}

async function applyServerOp(db: IDBPDatabase<MyDB>, op: ServerOp): Promise<void> {
    const handlers = buildEntityHandlers(db);
    await applyEntityOp(op, handlers[op.entityType]);
}

async function applyEntityOp(op: ServerOp, handlers: EntityApplyHandlers): Promise<void> {
    if (op.opType === 'delete') {
        await handlers.remove(op.entityId);
        return;
    }
    if (!op.snapshot) {
        return;
    }
    // Cast to the minimal shape needed here (updatedTs for conflict resolution);
    // handlers.put receives the full object as unknown and re-casts to the concrete type.
    const incoming = remapUser(op.snapshot as Record<string, unknown> & { user: string }) as unknown as { updatedTs: string };
    const existing = await handlers.getExisting(op.entityId);
    if (!existing || existing.updatedTs <= incoming.updatedTs) {
        await handlers.put(incoming);
        console.log(
            `[debug-gcal-sync][client] applyEntityOp put | type=${op.entityType} id=${op.entityId} existingTs=${existing?.updatedTs ?? 'none'} incomingTs=${incoming.updatedTs}`,
        );
    } else {
        console.log(
            `[debug-gcal-sync][client] applyEntityOp skipped (LWW) | type=${op.entityType} id=${op.entityId} existingTs=${existing.updatedTs} incomingTs=${incoming.updatedTs}`,
        );
    }
}
