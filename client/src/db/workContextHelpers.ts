import type { IDBPDatabase } from 'idb';
import type { MyDB, StoredWorkContext } from '../types/MyDB';

export async function getWorkContextsByUser(db: IDBPDatabase<MyDB>, userId: string): Promise<StoredWorkContext[]> {
    return db.getAllFromIndex('workContexts', 'userId', userId);
}

export async function putWorkContext(db: IDBPDatabase<MyDB>, workContext: StoredWorkContext): Promise<void> {
    await db.put('workContexts', workContext);
}

export async function deleteWorkContextById(db: IDBPDatabase<MyDB>, _id: string): Promise<void> {
    await db.delete('workContexts', _id);
}
