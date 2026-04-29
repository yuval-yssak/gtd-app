import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import type { MyDB, StoredPerson } from '../types/MyDB';
import { deletePersonById, putPerson } from './personHelpers';
import { queueSyncOp } from './syncHelpers';

function nowIso(): string {
    return dayjs().toISOString();
}

export type NewPersonFields = Omit<StoredPerson, '_id' | 'createdTs' | 'updatedTs'>;

export async function createPerson(db: IDBPDatabase<MyDB>, fields: NewPersonFields): Promise<StoredPerson> {
    const now = nowIso();
    const person: StoredPerson = { ...fields, _id: crypto.randomUUID(), createdTs: now, updatedTs: now };
    await putPerson(db, person);
    await queueSyncOp(db, { opType: 'create', entityType: 'person', entityId: person._id, snapshot: person, userId: person.userId });
    return person;
}

export async function updatePerson(db: IDBPDatabase<MyDB>, person: StoredPerson): Promise<StoredPerson> {
    const updated: StoredPerson = { ...person, updatedTs: nowIso() };
    await putPerson(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'person', entityId: updated._id, snapshot: updated, userId: updated.userId });
    return updated;
}

export async function removePerson(db: IDBPDatabase<MyDB>, personId: string): Promise<void> {
    // Read the owning userId before delete so the queued op is scoped to the right account
    // even when the person belongs to a non-active session.
    const existing = await db.get('people', personId);
    await deletePersonById(db, personId);
    await queueSyncOp(db, {
        opType: 'delete',
        entityType: 'person',
        entityId: personId,
        snapshot: null,
        ...(existing?.userId ? { userId: existing.userId } : {}),
    });
}
