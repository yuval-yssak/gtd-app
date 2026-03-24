import type { IDBPDatabase } from 'idb';
import type { MyDB, StoredItem, SyncOpType } from '../types/MyDB';
import { bulkPutItems, deleteItemById, getItemsByUser } from './itemHelpers';

// Shape returned by GET /items — `user` is the server field name, `_id` is the MongoDB string UUID
interface ApiItem extends Omit<StoredItem, 'userId'> {
    _id: string;
    user: string;
}

export async function queueSyncOp(db: IDBPDatabase<MyDB>, type: SyncOpType, itemId: string): Promise<void> {
    const existing = (await db.getAll('syncOperations')).filter((op) => op.itemId === itemId);

    if (type === 'update' && existing.some((op) => op.type === 'create')) {
        // The pending 'create' will carry the latest IndexedDB state when flushed — no extra op needed
        return;
    }

    if (type === 'delete') {
        // Replace any prior ops for this item with a single 'delete'
        for (const op of existing) {
            await db.delete('syncOperations', op.id!);
        }
    }

    await db.add('syncOperations', { type, itemId, queuedAt: new Date().toISOString() });
}

export async function flushSyncQueue(db: IDBPDatabase<MyDB>): Promise<void> {
    const ops = await db.getAll('syncOperations');

    for (const op of ops) {
        try {
            if (op.type === 'create') {
                const item = await db.get('items', op.itemId);
                if (!item) {
                    // Item was deleted before sync — skip this create
                    await db.delete('syncOperations', op.id!);
                    continue;
                }
                const { userId, ...body } = item;
                const res = await fetch('/items', {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                if (!res.ok) throw new Error(`POST /items ${res.status}`);
            } else if (op.type === 'update') {
                const item = await db.get('items', op.itemId);
                if (!item) {
                    await db.delete('syncOperations', op.id!);
                    continue;
                }
                const { userId, _id, ...body } = item;
                const res = await fetch(`/items/${op.itemId}`, {
                    method: 'PUT',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                if (!res.ok) throw new Error(`PUT /items/${op.itemId} ${res.status}`);
            } else if (op.type === 'delete') {
                const res = await fetch(`/items/${op.itemId}`, { method: 'DELETE', credentials: 'include' });
                if (!res.ok) throw new Error(`DELETE /items/${op.itemId} ${res.status}`);
            }
            await db.delete('syncOperations', op.id!);
        } catch {
            // Stop on first failure — preserve remaining ops in order so they retry next time online
            break;
        }
    }
}

export async function seedItemsFromServer(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    const res = await fetch('/items', { credentials: 'include' });
    if (!res.ok) throw new Error(`GET /items ${res.status}`);
    const apiItems: ApiItem[] = await res.json();

    // Map server field `user` → IndexedDB field `userId`
    const stored: StoredItem[] = apiItems.map(({ user, ...rest }) => ({ ...rest, userId: user }));
    await bulkPutItems(db, stored);

    // Remove IndexedDB items for this user that are no longer on the server (deleted elsewhere)
    const serverIds = new Set(apiItems.map((i) => i._id));
    const localItems = await getItemsByUser(db, userId);
    for (const item of localItems) {
        if (!serverIds.has(item._id)) await deleteItemById(db, item._id);
    }
}
