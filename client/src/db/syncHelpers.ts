import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { API_SERVER } from '../constants/globals';
import type { EntityType, MyDB, OpType, StoredEntity, StoredItem, StoredPerson, StoredRoutine, StoredWorkContext } from '../types/MyDB';
import { getLastSyncedTs, getOrCreateDeviceId, setLastSyncedTs } from './deviceId';
import { bulkPutItems, deleteItemById, putItem } from './itemHelpers';
import { deletePersonById, putPerson } from './personHelpers';
import { deleteRoutineById, putRoutine } from './routineHelpers';
import { deleteWorkContextById, putWorkContext } from './workContextHelpers';

// Shape returned by GET /sync/pull — snapshot uses `user` (server field name)
interface ServerOp {
    entityType: EntityType;
    entityId: string;
    opType: OpType;
    snapshot: (Record<string, unknown> & { user?: string }) | null;
}

interface BootstrapPayload {
    items: (Record<string, unknown> & { user: string })[];
    routines: (Record<string, unknown> & { user: string })[];
    people: (Record<string, unknown> & { user: string })[];
    workContexts: (Record<string, unknown> & { user: string })[];
    serverTs: string;
}

function remapUser<T extends Record<string, unknown>>(doc: T & { user: string }): Omit<T, 'user'> & { userId: string } {
    const { user, ...rest } = doc;
    return { ...rest, userId: user } as Omit<T, 'user'> & { userId: string };
}

export async function queueSyncOp(
    db: IDBPDatabase<MyDB>,
    opType: OpType,
    entityType: EntityType,
    entityId: string,
    // Snapshot of the entity at the moment of the change; null for deletes.
    // Stored at queue-time so flush can send it directly without re-reading IndexedDB.
    snapshot: StoredEntity | null,
): Promise<void> {
    const existing = (await db.getAll('syncOperations')).filter((op) => op.entityId === entityId);

    if (opType === 'update' && existing.some((op) => op.opType === 'create')) {
        // Update the snapshot on the pending 'create' rather than adding a second op.
        // The single create will carry the latest state to the server.
        for (const op of existing) {
            if (op.opType !== 'create' || op.id === undefined) continue;
            await db.delete('syncOperations', op.id);
            await db.add('syncOperations', { opType: 'create', entityType, entityId, queuedAt: op.queuedAt, snapshot });
        }
        return;
    }

    if (opType === 'delete') {
        // Collapse all prior ops into a single delete. If a 'create' was pending,
        // the item never reached the server, so we can drop everything entirely.
        const hadPendingCreate = existing.some((op) => op.opType === 'create');
        for (const op of existing) {
            if (op.id === undefined) continue;
            await db.delete('syncOperations', op.id);
        }
        if (hadPendingCreate) return; // item never reached server — nothing to send
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
    const res = await fetch(`${API_SERVER}/sync/push`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, ops }),
    });
    if (!res.ok) throw new Error(`POST /sync/push ${res.status}`);

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

    const res = await fetch(`${API_SERVER}/sync/bootstrap`, { credentials: 'include' });
    if (!res.ok) throw new Error(`GET /sync/bootstrap ${res.status}`);

    const { items, routines, people, workContexts, serverTs } = (await res.json()) as BootstrapPayload;

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

    const res = await fetch(`${API_SERVER}/sync/pull?since=${encodeURIComponent(since)}&deviceId=${encodeURIComponent(deviceId)}`, {
        credentials: 'include',
    });
    if (!res.ok) throw new Error(`GET /sync/pull ${res.status}`);

    const { ops, serverTs } = (await res.json()) as { ops: ServerOp[]; serverTs: string };

    for (const op of ops) {
        await applyServerOp(db, op);
    }

    await setLastSyncedTs(db, serverTs);
}

async function applyServerOp(db: IDBPDatabase<MyDB>, op: ServerOp): Promise<void> {
    switch (op.entityType) {
        case 'item':
            return applyItemServerOp(db, op);
        case 'routine':
            return applyRoutineServerOp(db, op);
        case 'person':
            return applyPersonServerOp(db, op);
        case 'workContext':
            return applyWorkContextServerOp(db, op);
    }
}

async function applyItemServerOp(db: IDBPDatabase<MyDB>, op: ServerOp): Promise<void> {
    if (op.opType === 'delete') {
        await deleteItemById(db, op.entityId);
        return;
    }
    if (!op.snapshot) {
        return;
    }
    const incoming = remapUser(op.snapshot as Record<string, unknown> & { user: string }) as unknown as StoredItem;
    const existing = await db.get('items', op.entityId);
    if (!existing || existing.updatedTs <= incoming.updatedTs) {
        await putItem(db, incoming);
    }
}

async function applyRoutineServerOp(db: IDBPDatabase<MyDB>, op: ServerOp): Promise<void> {
    if (op.opType === 'delete') {
        await deleteRoutineById(db, op.entityId);
        return;
    }
    if (!op.snapshot) {
        return;
    }
    const incoming = remapUser(op.snapshot as Record<string, unknown> & { user: string }) as unknown as StoredRoutine;
    const existing = await db.get('routines', op.entityId);
    if (!existing || existing.updatedTs <= incoming.updatedTs) {
        await putRoutine(db, incoming);
    }
}

async function applyPersonServerOp(db: IDBPDatabase<MyDB>, op: ServerOp): Promise<void> {
    if (op.opType === 'delete') {
        await deletePersonById(db, op.entityId);
        return;
    }
    if (!op.snapshot) {
        return;
    }
    const incoming = remapUser(op.snapshot as Record<string, unknown> & { user: string }) as unknown as StoredPerson;
    const existing = await db.get('people', op.entityId);
    if (!existing || existing.updatedTs <= incoming.updatedTs) {
        await putPerson(db, incoming);
    }
}

async function applyWorkContextServerOp(db: IDBPDatabase<MyDB>, op: ServerOp): Promise<void> {
    if (op.opType === 'delete') {
        await deleteWorkContextById(db, op.entityId);
        return;
    }
    if (!op.snapshot) {
        return;
    }
    const incoming = remapUser(op.snapshot as Record<string, unknown> & { user: string }) as unknown as StoredWorkContext;
    const existing = await db.get('workContexts', op.entityId);
    if (!existing || existing.updatedTs <= incoming.updatedTs) {
        await putWorkContext(db, incoming);
    }
}
