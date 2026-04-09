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

    it('initializes lastSyncedTs to epoch', async () => {
        await getOrCreateDeviceId(db);
        const state = await db.get('deviceSyncState', 'local');
        expect(state?.lastSyncedTs).toBe(dayjs(0).toISOString());
    });
});

// ── getLastSyncedTs ───────────────────────────────────────────────────────────

describe('getLastSyncedTs', () => {
    it('returns epoch when no device state exists', async () => {
        const ts = await getLastSyncedTs(db);
        expect(ts).toBe(dayjs(0).toISOString());
    });

    it('returns stored value when device state exists', async () => {
        await getOrCreateDeviceId(db);
        const customTs = '2025-06-01T12:00:00.000Z';
        await setLastSyncedTs(db, customTs);

        expect(await getLastSyncedTs(db)).toBe(customTs);
    });
});

// ── setLastSyncedTs ───────────────────────────────────────────────────────────

describe('setLastSyncedTs', () => {
    it('updates the lastSyncedTs in device state', async () => {
        await getOrCreateDeviceId(db);
        const newTs = '2025-07-15T08:30:00.000Z';
        await setLastSyncedTs(db, newTs);

        const state = await db.get('deviceSyncState', 'local');
        expect(state?.lastSyncedTs).toBe(newTs);
    });

    it('preserves the deviceId when updating timestamp', async () => {
        const deviceId = await getOrCreateDeviceId(db);
        await setLastSyncedTs(db, '2025-07-15T08:30:00.000Z');

        const state = await db.get('deviceSyncState', 'local');
        expect(state?.deviceId).toBe(deviceId);
    });

    it('does nothing when no device state exists', async () => {
        await setLastSyncedTs(db, '2025-07-15T08:30:00.000Z');
        const state = await db.get('deviceSyncState', 'local');
        expect(state).toBeUndefined();
    });
});
