import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import type { EntityType, MyDB, OpType, StoredEntity, StoredItem } from '../types/MyDB';
import { getOrCreateDeviceId, getLastSyncedTs, setLastSyncedTs } from './deviceId';
import { deleteItemById } from './itemHelpers';

// Shape returned by GET /sync/pull — snapshot uses `user` (server field name)
interface ServerOp {
    entityType: EntityType;
    entityId: string;
    opType: OpType;
    snapshot: (Record<string, unknown> & { user?: string }) | null;
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

    // Register a background sync so the SW can flush the queue even if the app is closed.
    // No-op in browsers that don't support the Background Sync API (Firefox, Safari).
    if ('serviceWorker' in navigator && 'sync' in ServiceWorkerRegistration.prototype) {
        // Background Sync API isn't in the standard TS DOM lib — cast through unknown
        navigator.serviceWorker.ready
            .then((reg) => (reg as unknown as { sync: { register(tag: string): Promise<void> } }).sync.register('gtd-sync-queue'))
            .catch(() => { /* registration failure is non-fatal — online flush will still run */ });
    }
}

export async function flushSyncQueue(db: IDBPDatabase<MyDB>): Promise<void> {
    const ops = await db.getAll('syncOperations');
    if (!ops.length) return;

    const deviceId = await getOrCreateDeviceId(db);
    const res = await fetch('/sync/push', {
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

export async function pullFromServer(db: IDBPDatabase<MyDB>): Promise<void> {
    const deviceId = await getOrCreateDeviceId(db);
    const since = await getLastSyncedTs(db);

    const res = await fetch(`/sync/pull?since=${encodeURIComponent(since)}&deviceId=${encodeURIComponent(deviceId)}`, {
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
    // Only items are synced today; other entity types will be wired up as their routes ship
    if (op.entityType !== 'item') return;

    if (op.opType === 'delete') {
        await deleteItemById(db, op.entityId);
        return;
    }

    if (!op.snapshot) return;
    // Remap server field `user` → IndexedDB field `userId`
    const { user, ...rest } = op.snapshot as Record<string, unknown> & { user: string };
    const incoming = { ...rest, userId: user } as StoredItem;

    // Last-write-wins: skip if we already have a newer local version
    const existing = await db.get('items', op.entityId);
    if (!existing || existing.updatedTs <= incoming.updatedTs) {
        await db.put('items', incoming);
    }
}
