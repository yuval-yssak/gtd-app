import type { IDBPDatabase } from 'idb';
import type { MyDB, StoredClaudeAsk } from '../types/MyDB';

export async function getClaudeAsksByUser(db: IDBPDatabase<MyDB>, userId: string): Promise<StoredClaudeAsk[]> {
    return db.getAllFromIndex('claudeAsks', 'userId', userId);
}

/** Reads Claude asks across multiple user IDs and flattens the result. See itemHelpers.getItemsAcrossUsers for rationale. */
export async function getClaudeAsksAcrossUsers(db: IDBPDatabase<MyDB>, userIds: string[]): Promise<StoredClaudeAsk[]> {
    const perUser = await Promise.all(userIds.map((uid) => db.getAllFromIndex('claudeAsks', 'userId', uid)));
    return perUser.flat();
}

export async function getClaudeAskById(db: IDBPDatabase<MyDB>, askId: string): Promise<StoredClaudeAsk | undefined> {
    return db.get('claudeAsks', askId);
}
