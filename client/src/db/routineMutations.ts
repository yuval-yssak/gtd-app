import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import type { MyDB, StoredRoutine } from '../types/MyDB';
import { deleteRoutineById, putRoutine } from './routineHelpers';
import { queueSyncOp } from './syncHelpers';

function nowIso(): string {
    return dayjs().toISOString();
}

export type NewRoutineFields = Omit<StoredRoutine, '_id' | 'createdTs' | 'updatedTs'>;

export async function createRoutine(db: IDBPDatabase<MyDB>, fields: NewRoutineFields): Promise<StoredRoutine> {
    const now = nowIso();
    const routine: StoredRoutine = { ...fields, _id: crypto.randomUUID(), createdTs: now, updatedTs: now };
    await putRoutine(db, routine);
    await queueSyncOp(db, { opType: 'create', entityType: 'routine', entityId: routine._id, snapshot: routine });
    return routine;
}

export async function updateRoutine(db: IDBPDatabase<MyDB>, routine: StoredRoutine): Promise<StoredRoutine> {
    const updated: StoredRoutine = { ...routine, updatedTs: nowIso() };
    await putRoutine(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'routine', entityId: updated._id, snapshot: updated });
    return updated;
}

export async function removeRoutine(db: IDBPDatabase<MyDB>, routineId: string): Promise<void> {
    await deleteRoutineById(db, routineId);
    await queueSyncOp(db, { opType: 'delete', entityType: 'routine', entityId: routineId, snapshot: null });
}
