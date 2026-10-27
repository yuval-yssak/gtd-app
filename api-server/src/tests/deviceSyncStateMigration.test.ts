import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateDeviceSyncStateToPerUserCursor } from '../loaders/deviceSyncStateMigration.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { DeviceSyncStateInterface } from '../types/entities.js';

/** A deviceSyncState row in any migration state: legacy (`_id = deviceId`, possibly malformed) or per-user. */
type AnyShapeDeviceSyncStateRow = { _id: string } & Partial<Omit<DeviceSyncStateInterface, '_id'>>;

const deviceSyncState = () => db.collection<AnyShapeDeviceSyncStateRow>('deviceSyncState');

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await deviceSyncState().deleteMany({});
});

describe('migrateDeviceSyncStateToPerUserCursor', () => {
    it('converts an old _id=deviceId row into a per-(device, user) row keeping all fields', async () => {
        const lastSyncedTs = '2024-06-01T10:00:00.000Z';
        const lastSeenTs = '2024-06-01T11:00:00.000Z';
        await deviceSyncState().insertOne({
            _id: 'dev-1',
            user: 'user-a',
            lastSyncedTs,
            lastSeenTs,
            name: 'Alice phone',
        });

        await migrateDeviceSyncStateToPerUserCursor(db);

        const newRow = await deviceSyncState().findOne({ _id: 'dev-1::user-a' });
        const oldRow = await deviceSyncState().findOne({ _id: 'dev-1' });
        expect(newRow).not.toBeNull();
        expect(oldRow).toBeNull();
        expect(newRow?.deviceId).toBe('dev-1');
        expect(newRow?.user).toBe('user-a');
        expect(newRow?.lastSyncedTs).toBe(lastSyncedTs);
        expect(newRow?.lastSeenTs).toBe(lastSeenTs);
        expect(newRow?.name).toBe('Alice phone');
    });

    it('is idempotent — re-running leaves the new row unchanged and removes any leftover legacy row', async () => {
        await deviceSyncState().insertOne({
            _id: 'dev-1::user-a',
            deviceId: 'dev-1',
            user: 'user-a',
            lastSyncedTs: '2024-06-01T10:00:00.000Z',
            lastSeenTs: '2024-06-01T11:00:00.000Z',
        });

        await migrateDeviceSyncStateToPerUserCursor(db);
        await migrateDeviceSyncStateToPerUserCursor(db);

        expect(await deviceSyncState().countDocuments()).toBe(1);
        const row = await deviceSyncState().findOne({ _id: 'dev-1::user-a' });
        expect(row?.deviceId).toBe('dev-1');
    });

    it('skips malformed legacy rows that have no user field', async () => {
        await deviceSyncState().insertOne({
            _id: 'dev-orphan',
            lastSyncedTs: '2024-06-01T10:00:00.000Z',
            lastSeenTs: '2024-06-01T11:00:00.000Z',
        });

        await migrateDeviceSyncStateToPerUserCursor(db);

        // Orphan stays where it is — no migration target. Subsequent runs leave it alone too.
        const row = await deviceSyncState().findOne({ _id: 'dev-orphan' });
        expect(row).not.toBeNull();
        expect(await deviceSyncState().countDocuments()).toBe(1);
    });

    it('does nothing when there are no legacy rows', async () => {
        await deviceSyncState().insertOne({
            _id: 'dev-1::user-a',
            deviceId: 'dev-1',
            user: 'user-a',
            lastSyncedTs: '2024-06-01T10:00:00.000Z',
            lastSeenTs: '2024-06-01T11:00:00.000Z',
        });

        await migrateDeviceSyncStateToPerUserCursor(db);

        expect(await deviceSyncState().countDocuments()).toBe(1);
    });

    it('preserves a fresher per-user row already written by a live instance (blue/green safety)', async () => {
        // Legacy row from before deploy.
        const staleTs = '2024-06-01T10:00:00.000Z';
        await deviceSyncState().insertOne({
            _id: 'dev-1',
            user: 'user-a',
            lastSyncedTs: staleTs,
            lastSeenTs: staleTs,
        });
        // Fresher per-user row that the *previous* (still-running) app instance just wrote
        // because user-a pulled while the new instance was booting.
        const freshTs = '2025-01-01T00:00:00.000Z';
        await deviceSyncState().insertOne({
            _id: 'dev-1::user-a',
            deviceId: 'dev-1',
            user: 'user-a',
            lastSyncedTs: freshTs,
            lastSeenTs: freshTs,
        });

        await migrateDeviceSyncStateToPerUserCursor(db);

        const row = await deviceSyncState().findOne({ _id: 'dev-1::user-a' });
        expect(row?.lastSyncedTs).toBe(freshTs);
        expect(row?.lastSeenTs).toBe(freshTs);
        // Legacy row was still cleaned up.
        expect(await deviceSyncState().countDocuments({ _id: 'dev-1' })).toBe(0);
    });

    it('two concurrent migrations converge to the same final state', async () => {
        const lastSyncedTs = '2024-06-01T10:00:00.000Z';
        const lastSeenTs = '2024-06-01T11:00:00.000Z';
        await deviceSyncState().insertOne({
            _id: 'dev-1',
            user: 'user-a',
            lastSyncedTs,
            lastSeenTs,
        });

        await Promise.all([migrateDeviceSyncStateToPerUserCursor(db), migrateDeviceSyncStateToPerUserCursor(db)]);

        expect(await deviceSyncState().countDocuments()).toBe(1);
        const row = await deviceSyncState().findOne({ _id: 'dev-1::user-a' });
        expect(row).not.toBeNull();
        expect(row?.deviceId).toBe('dev-1');
        expect(row?.user).toBe('user-a');
        expect(row?.lastSyncedTs).toBe(lastSyncedTs);
        expect(row?.lastSeenTs).toBe(lastSeenTs);
    });

    it('skips legacy rows missing required timestamp fields', async () => {
        await deviceSyncState().insertOne({
            _id: 'dev-broken',
            user: 'user-a',
            // No lastSyncedTs or lastSeenTs.
        });

        await migrateDeviceSyncStateToPerUserCursor(db);

        // Broken row stays put — manual cleanup or stale-device prune will eventually remove it.
        expect(await deviceSyncState().countDocuments({ _id: 'dev-broken' })).toBe(1);
        expect(await deviceSyncState().countDocuments({ _id: /::/ })).toBe(0);
    });
});
