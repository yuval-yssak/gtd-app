import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLastSyncedTs, getOrCreateDeviceId, setLastSyncedTs } from '../db/deviceId';
import type { MyDB } from '../types/MyDB';
import { openTestDB } from './openTestDB';

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    db = await openTestDB();
});

afterEach(() => {
    db.close();
});

// ── getOrCreateDeviceId ───────────────────────────────────────────────────────

describe('getOrCreateDeviceId', () => {
    it('creates a new device id on first call', async () => {
        const id = await getOrCreateDeviceId(db);
        expect(id).toBeTruthy();
        expect(typeof id).toBe('string');
    });

    it('returns the same id on subsequent calls', async () => {
        const first = await getOrCreateDeviceId(db);
        const second = await getOrCreateDeviceId(db);
        expect(second).toBe(first);
    });

    it('writes a deviceMeta singleton with flush lock cleared', async () => {
        await getOrCreateDeviceId(db);
        const state = await db.get('deviceMeta', 'local');
        expect(state?.flushingTs).toBeNull();
    });
});

// ── getLastSyncedTs ───────────────────────────────────────────────────────────

describe('getLastSyncedTs', () => {
    it('returns epoch when no cursor exists for this user', async () => {
        const ts = await getLastSyncedTs(db, 'user-a');
        expect(ts).toBe(dayjs(0).toISOString());
    });

    it('returns stored value when a cursor exists', async () => {
        const customTs = '2025-06-01T12:00:00.000Z';
        await setLastSyncedTs(db, 'user-a', customTs);
        expect(await getLastSyncedTs(db, 'user-a')).toBe(customTs);
    });

    it('keeps cursors per-user — reads don’t leak across users', async () => {
        await setLastSyncedTs(db, 'user-a', '2025-06-01T12:00:00.000Z');
        await setLastSyncedTs(db, 'user-b', '2025-08-15T09:00:00.000Z');
        expect(await getLastSyncedTs(db, 'user-a')).toBe('2025-06-01T12:00:00.000Z');
        expect(await getLastSyncedTs(db, 'user-b')).toBe('2025-08-15T09:00:00.000Z');
    });
});

// ── setLastSyncedTs ───────────────────────────────────────────────────────────

describe('setLastSyncedTs', () => {
    it('writes the cursor row for the given user', async () => {
        const newTs = '2025-07-15T08:30:00.000Z';
        await setLastSyncedTs(db, 'user-a', newTs);
        const row = await db.get('syncCursors', 'user-a');
        expect(row?.lastSyncedTs).toBe(newTs);
        expect(row?.userId).toBe('user-a');
    });

    it('does not require a deviceMeta row to exist (cursors are independent of device meta)', async () => {
        // No prior getOrCreateDeviceId call.
        await setLastSyncedTs(db, 'user-a', '2025-07-15T08:30:00.000Z');
        expect(await getLastSyncedTs(db, 'user-a')).toBe('2025-07-15T08:30:00.000Z');
    });

    it('updating one user’s cursor does not touch another user’s row', async () => {
        await setLastSyncedTs(db, 'user-a', '2025-06-01T12:00:00.000Z');
        await setLastSyncedTs(db, 'user-b', '2025-08-15T09:00:00.000Z');
        await setLastSyncedTs(db, 'user-a', '2025-09-01T00:00:00.000Z');
        expect(await getLastSyncedTs(db, 'user-a')).toBe('2025-09-01T00:00:00.000Z');
        expect(await getLastSyncedTs(db, 'user-b')).toBe('2025-08-15T09:00:00.000Z');
    });
});
