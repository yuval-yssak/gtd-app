import type { IDBPDatabase } from 'idb';
import type { MyDB, StoredRoutine } from '../types/MyDB';

export async function getRoutinesByUser(db: IDBPDatabase<MyDB>, userId: string): Promise<StoredRoutine[]> {
    return db.getAllFromIndex('routines', 'userId', userId);
}

/** Reads routines across multiple user IDs and flattens the result. See itemHelpers.getItemsAcrossUsers for rationale. */
export async function getRoutinesAcrossUsers(db: IDBPDatabase<MyDB>, userIds: string[]): Promise<StoredRoutine[]> {
    const perUser = await Promise.all(userIds.map((uid) => db.getAllFromIndex('routines', 'userId', uid)));
    return perUser.flat();
}

export async function getRoutineById(db: IDBPDatabase<MyDB>, routineId: string): Promise<StoredRoutine | undefined> {
    return db.get('routines', routineId);
}

export async function putRoutine(db: IDBPDatabase<MyDB>, routine: StoredRoutine): Promise<void> {
    await db.put('routines', routine);
}

export async function deleteRoutineById(db: IDBPDatabase<MyDB>, _id: string): Promise<void> {
    await db.delete('routines', _id);
}
