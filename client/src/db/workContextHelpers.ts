import type { IDBPDatabase } from 'idb';
import type { MyDB, StoredWorkContext } from '../types/MyDB';

export async function getWorkContextsByUser(db: IDBPDatabase<MyDB>, userId: string): Promise<StoredWorkContext[]> {
    return db.getAllFromIndex('workContexts', 'userId', userId);
}

/** Reads work contexts across multiple user IDs and flattens the result. See itemHelpers.getItemsAcrossUsers for rationale. */
export async function getWorkContextsAcrossUsers(db: IDBPDatabase<MyDB>, userIds: string[]): Promise<StoredWorkContext[]> {
    const perUser = await Promise.all(userIds.map((uid) => db.getAllFromIndex('workContexts', 'userId', uid)));
    return perUser.flat();
}

export async function putWorkContext(db: IDBPDatabase<MyDB>, workContext: StoredWorkContext): Promise<void> {
    await db.put('workContexts', workContext);
}

export async function deleteWorkContextById(db: IDBPDatabase<MyDB>, _id: string): Promise<void> {
    await db.delete('workContexts', _id);
}
