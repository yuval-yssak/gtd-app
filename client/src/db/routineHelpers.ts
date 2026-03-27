import type { IDBPDatabase } from 'idb';
import type { MyDB, StoredRoutine } from '../types/MyDB';

export async function getRoutinesByUser(db: IDBPDatabase<MyDB>, userId: string): Promise<StoredRoutine[]> {
    return db.getAllFromIndex('routines', 'userId', userId);
}

export async function putRoutine(db: IDBPDatabase<MyDB>, routine: StoredRoutine): Promise<void> {
    await db.put('routines', routine);
}

export async function deleteRoutineById(db: IDBPDatabase<MyDB>, _id: string): Promise<void> {
    await db.delete('routines', _id);
}
