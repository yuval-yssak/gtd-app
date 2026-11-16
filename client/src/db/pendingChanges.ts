import type { IDBPDatabase } from 'idb';
import type { EntityType, MyDB } from '../types/MyDB';

export interface EntityRef {
    entityType: EntityType;
    entityId: string;
}

/**
 * True while a local change to the entity still waits in the sync queue — the server has not got it.
 * Matched on the (type, id) pair: a brief borrows its item's id, and is not a change to the item.
 */
export async function hasPendingChanges(db: IDBPDatabase<MyDB>, { entityType, entityId }: EntityRef): Promise<boolean> {
    const queued = await db.getAll('syncOperations');
    return queued.some((op) => op.entityType === entityType && op.entityId === entityId);
}
