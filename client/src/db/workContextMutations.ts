import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import type { MyDB, StoredWorkContext } from '../types/MyDB';
import { queueSyncOp } from './syncHelpers';
import { deleteWorkContextById, putWorkContext } from './workContextHelpers';

function nowIso(): string {
    return dayjs().toISOString();
}

export type NewWorkContextFields = Omit<StoredWorkContext, '_id' | 'createdTs' | 'updatedTs'>;

export async function createWorkContext(db: IDBPDatabase<MyDB>, fields: NewWorkContextFields): Promise<StoredWorkContext> {
    const now = nowIso();
    const workContext: StoredWorkContext = { ...fields, _id: crypto.randomUUID(), createdTs: now, updatedTs: now };
    await putWorkContext(db, workContext);
    await queueSyncOp(db, { opType: 'create', entityType: 'workContext', entityId: workContext._id, snapshot: workContext, userId: workContext.userId });
    return workContext;
}

export async function updateWorkContext(db: IDBPDatabase<MyDB>, workContext: StoredWorkContext): Promise<StoredWorkContext> {
    const updated: StoredWorkContext = { ...workContext, updatedTs: nowIso() };
    await putWorkContext(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'workContext', entityId: updated._id, snapshot: updated, userId: updated.userId });
    return updated;
}

export async function removeWorkContext(db: IDBPDatabase<MyDB>, workContextId: string): Promise<void> {
    // Read the owning userId before delete so the queued delete op is scoped to the right account.
    const existing = await db.get('workContexts', workContextId);
    await deleteWorkContextById(db, workContextId);
    await queueSyncOp(db, {
        opType: 'delete',
        entityType: 'workContext',
        entityId: workContextId,
        snapshot: null,
        ...(existing?.userId ? { userId: existing.userId } : {}),
    });
}
