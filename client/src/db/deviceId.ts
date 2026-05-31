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
 * Cursor id-component sentinel that sorts strictly above every operation `_id`. Mirrors the
 * server's `MAX_OP_ID`. Used as the id component of a bootstrap cursor: the snapshot already holds
 * every op at exactly `serverTs`, so `(serverTs, MAX_OP_ID)` means "all delivered ≤ serverTs" and
 * the first incremental pull won't re-fetch them. Never use it for a mid-stream cursor — that would
 * skip the rest of a same-`ts` tie-group (the bug the compound cursor prevents); use '' there.
 */
export const MAX_OP_ID = '￿';

/**
 * Reads the per-user compound pull cursor `(ts, id)`. Returns `{ epoch, '' }` when no row exists —
 * epoch matches the server's `since` default, and `''` (lowest id) makes the first pull re-check the
 * whole boundary ms. Legacy rows lacking `lastSyncedId` (pre-v6) read as `''` for the same reason.
 */
export async function getSyncCursor(db: IDBPDatabase<MyDB>, userId: string): Promise<{ ts: string; id: string }> {
    const row = await db.get('syncCursors', userId);
    return { ts: row?.lastSyncedTs ?? dayjs(0).toISOString(), id: row?.lastSyncedId ?? '' };
}

/**
 * Writes the per-user compound pull cursor. Each Better Auth session on this device tracks its own
 * cursor — a shared cursor would let one session's pull advance past another session's boundary op.
 */
export async function setSyncCursor(db: IDBPDatabase<MyDB>, userId: string, ts: string, id: string): Promise<void> {
    await db.put('syncCursors', { userId, lastSyncedTs: ts, lastSyncedId: id });
}
