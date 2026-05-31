import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getOrCreateDeviceId, getSyncCursor, MAX_OP_ID, setSyncCursor } from '../db/deviceId';
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

// ── getSyncCursor ───────────────────────────────────────────────────────────

describe('getSyncCursor', () => {
    it('returns { epoch, empty-id } when no cursor exists for this user', async () => {
        const cursor = await getSyncCursor(db, 'user-a');
        expect(cursor.ts).toBe(dayjs(0).toISOString());
        // '' (lowest id) → the first pull re-checks the whole boundary ms rather than skipping it.
        expect(cursor.id).toBe('');
    });

    it('returns the stored compound pair when a cursor exists', async () => {
        await setSyncCursor(db, 'user-a', '2025-06-01T12:00:00.000Z', 'op-7');
        const cursor = await getSyncCursor(db, 'user-a');
        expect(cursor).toEqual({ ts: '2025-06-01T12:00:00.000Z', id: 'op-7' });
    });

    it("reads a legacy row lacking lastSyncedId as id ''", async () => {
        // Simulate a row that predates the compound cursor (the v6 backfill target).
        await db.put('syncCursors', { userId: 'user-a', lastSyncedTs: '2025-06-01T12:00:00.000Z' } as never);
        const cursor = await getSyncCursor(db, 'user-a');
        expect(cursor).toEqual({ ts: '2025-06-01T12:00:00.000Z', id: '' });
    });

    it('keeps cursors per-user — reads don’t leak across users', async () => {
        await setSyncCursor(db, 'user-a', '2025-06-01T12:00:00.000Z', 'op-a');
        await setSyncCursor(db, 'user-b', '2025-08-15T09:00:00.000Z', 'op-b');
        expect(await getSyncCursor(db, 'user-a')).toEqual({ ts: '2025-06-01T12:00:00.000Z', id: 'op-a' });
        expect(await getSyncCursor(db, 'user-b')).toEqual({ ts: '2025-08-15T09:00:00.000Z', id: 'op-b' });
    });
});

// ── setSyncCursor ───────────────────────────────────────────────────────────

describe('setSyncCursor', () => {
    it('writes the compound cursor row for the given user', async () => {
        await setSyncCursor(db, 'user-a', '2025-07-15T08:30:00.000Z', MAX_OP_ID);
        const row = await db.get('syncCursors', 'user-a');
        expect(row?.lastSyncedTs).toBe('2025-07-15T08:30:00.000Z');
        expect(row?.lastSyncedId).toBe(MAX_OP_ID);
        expect(row?.userId).toBe('user-a');
    });

    it('does not require a deviceMeta row to exist (cursors are independent of device meta)', async () => {
        await setSyncCursor(db, 'user-a', '2025-07-15T08:30:00.000Z', 'op-1');
        expect(await getSyncCursor(db, 'user-a')).toEqual({ ts: '2025-07-15T08:30:00.000Z', id: 'op-1' });
    });

    it('updating one user’s cursor does not touch another user’s row', async () => {
        await setSyncCursor(db, 'user-a', '2025-06-01T12:00:00.000Z', 'op-a1');
        await setSyncCursor(db, 'user-b', '2025-08-15T09:00:00.000Z', 'op-b1');
        await setSyncCursor(db, 'user-a', '2025-09-01T00:00:00.000Z', 'op-a2');
        expect(await getSyncCursor(db, 'user-a')).toEqual({ ts: '2025-09-01T00:00:00.000Z', id: 'op-a2' });
        expect(await getSyncCursor(db, 'user-b')).toEqual({ ts: '2025-08-15T09:00:00.000Z', id: 'op-b1' });
    });
});
