import type { IDBPDatabase } from 'idb';
import type { MyDB, StoredItemBrief } from '../types/MyDB';

export async function getItemBriefsByUser(db: IDBPDatabase<MyDB>, userId: string): Promise<StoredItemBrief[]> {
    return db.getAllFromIndex('itemBriefs', 'userId', userId);
}

/** Reads item briefs across multiple user IDs and flattens the result. See itemHelpers.getItemsAcrossUsers for rationale. */
export async function getItemBriefsAcrossUsers(db: IDBPDatabase<MyDB>, userIds: string[]): Promise<StoredItemBrief[]> {
    const perUser = await Promise.all(userIds.map((uid) => db.getAllFromIndex('itemBriefs', 'userId', uid)));
    return perUser.flat();
}

export async function getItemBriefById(db: IDBPDatabase<MyDB>, itemId: string): Promise<StoredItemBrief | undefined> {
    return db.get('itemBriefs', itemId);
}

export async function putItemBrief(db: IDBPDatabase<MyDB>, brief: StoredItemBrief): Promise<void> {
    await db.put('itemBriefs', brief);
}

export async function deleteItemBriefById(db: IDBPDatabase<MyDB>, itemId: string): Promise<void> {
    await db.delete('itemBriefs', itemId);
}
