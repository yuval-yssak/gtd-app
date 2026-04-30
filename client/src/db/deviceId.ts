import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import type { MyDB } from '../types/MyDB';

/**
 * Returns the stable device UUID, generating one on first launch. The deviceId lives in the
 * singleton `deviceMeta` store — shared across every Better Auth session on this device because
 * the server uses it to scope the per-(device, user) cursor and push subscriptions.
 */
export async function getOrCreateDeviceId(db: IDBPDatabase<MyDB>): Promise<string> {
    const existing = await db.get('deviceMeta', 'local');
    if (existing) {
        return existing.deviceId;
    }
    const deviceId = crypto.randomUUID();
    await db.put('deviceMeta', { _id: 'local', deviceId, flushingTs: null });
    return deviceId;
}

/**
 * Reads the per-user pull cursor. Returns epoch when no row exists — that matches the server's
 * `since = dayjs(0).toISOString()` default and ensures a brand-new account on this device pulls
 * everything since the start of time.
 */
export async function getLastSyncedTs(db: IDBPDatabase<MyDB>, userId: string): Promise<string> {
    const row = await db.get('syncCursors', userId);
    return row?.lastSyncedTs ?? dayjs(0).toISOString();
}

/**
 * Writes the per-user pull cursor. Each Better Auth session on this device tracks its own cursor
 * — a shared cursor would let one session's pull advance past another session's boundary op.
 */
export async function setLastSyncedTs(db: IDBPDatabase<MyDB>, userId: string, ts: string): Promise<void> {
    await db.put('syncCursors', { userId, lastSyncedTs: ts });
}
