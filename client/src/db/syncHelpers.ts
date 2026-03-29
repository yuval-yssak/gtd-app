import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import type { ServerOp } from '#api/syncClient';
import { fetchBootstrap, fetchSyncOps, pushSyncOps } from '#api/syncClient';
import type { EntityType, MyDB, OpType, StoredEntity, StoredItem, StoredPerson, StoredRoutine, StoredWorkContext } from '../types/MyDB';
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

function remapUser<T extends Record<string, unknown>>(doc: T & { user: string }): Omit<T, 'user'> & { userId: string } {
    const { user, ...rest } = doc;
    return { ...rest, userId: user } as Omit<T, 'user'> & { userId: string };
}

export async function queueSyncOp(db: IDBPDatabase<MyDB>, op: SyncOpParams): Promise<void> {
    const { opType, entityType, entityId, snapshot } = op;
    const existing = (await db.getAll('syncOperations')).filter((queued) => queued.entityId === entityId);

    if (opType === 'update' && existing.some((queued) => queued.opType === 'create')) {
        // Update the snapshot on the pending 'create' rather than adding a second op.
        // The single create will carry the latest state to the server.
        for (const queued of existing) {
            if (queued.opType !== 'create' || queued.id === undefined) {
                continue;
            }
            await db.delete('syncOperations', queued.id);
            await db.add('syncOperations', { opType: 'create', entityType, entityId, queuedAt: queued.queuedAt, snapshot });
        }
        return;
    }

    if (opType === 'delete') {
        // Collapse all prior ops into a single delete. If a 'create' was pending,
        // the item never reached the server, so we can drop everything entirely.
        const hadPendingCreate = existing.some((queued) => queued.opType === 'create');
        for (const queued of existing) {
            if (queued.id === undefined) {
                continue;
            }
            await db.delete('syncOperations', queued.id);
        }
        if (hadPendingCreate) {
            return; // item never reached server — nothing to send
        }
    }

    await db.add('syncOperations', { opType, entityType, entityId, queuedAt: dayjs().toISOString(), snapshot });

    // Attempt an immediate flush. Safari and Firefox don't support the Background Sync API,
    // so without this the op would sit in IDB until the next mount or online event.
    // Fire-and-forget — errors are non-fatal; the online handler and mount effect will retry.
    flushSyncQueue(db).catch(() => {});

    // Also register a background sync so the SW can flush even when the app is closed (Chrome/Edge only).
    if ('serviceWorker' in navigator && 'sync' in ServiceWorkerRegistration.prototype) {
        // Background Sync API isn't in the standard TS DOM lib — cast through unknown
        navigator.serviceWorker.ready
            .then((reg) => (reg as unknown as { sync: { register(tag: string): Promise<void> } }).sync.register('gtd-sync-queue'))
            .catch(() => {});
    }
}

export async function flushSyncQueue(db: IDBPDatabase<MyDB>): Promise<void> {
    const ops = await db.getAll('syncOperations');
    if (!ops.length) {
        return;
    }

    const deviceId = await getOrCreateDeviceId(db);
    await pushSyncOps(deviceId, ops);

    // Batch succeeded — remove all sent ops. If the request failed, they stay for retry.
    for (const op of ops) {
        if (op.id !== undefined) await db.delete('syncOperations', op.id);
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
    await db.put('deviceSyncState', { _id: 'local', deviceId, lastSyncedTs: serverTs });
}

export async function pullFromServer(db: IDBPDatabase<MyDB>): Promise<void> {
    const deviceId = await getOrCreateDeviceId(db);
    const since = await getLastSyncedTs(db);

    const { ops, serverTs } = await fetchSyncOps(since, deviceId);

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
    return applyEntityOp(op, handlers[op.entityType]);
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
    }
}
