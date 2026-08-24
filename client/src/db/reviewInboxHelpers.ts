import type { IDBPDatabase } from 'idb';
import type { MyDB, StoredReviewInbox } from '../types/MyDB';

function byOrder(a: StoredReviewInbox, b: StoredReviewInbox): number {
    return a.order - b.order || a.name.localeCompare(b.name);
}

export async function getReviewInboxesByUser(db: IDBPDatabase<MyDB>, userId: string): Promise<StoredReviewInbox[]> {
    const rows = await db.getAllFromIndex('reviewInboxes', 'userId', userId);
    return rows.sort(byOrder);
}

/** Reads review inboxes across multiple user IDs and flattens the result. See itemHelpers.getItemsAcrossUsers for rationale. */
export async function getReviewInboxesAcrossUsers(db: IDBPDatabase<MyDB>, userIds: string[]): Promise<StoredReviewInbox[]> {
    const perUser = await Promise.all(userIds.map((uid) => db.getAllFromIndex('reviewInboxes', 'userId', uid)));
    return perUser.flat().sort(byOrder);
}

export async function putReviewInbox(db: IDBPDatabase<MyDB>, reviewInbox: StoredReviewInbox): Promise<void> {
    await db.put('reviewInboxes', reviewInbox);
}

export async function deleteReviewInboxById(db: IDBPDatabase<MyDB>, _id: string): Promise<void> {
    await db.delete('reviewInboxes', _id);
}
