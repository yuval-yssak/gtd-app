/** Tests for deviceUsersDAO — the (deviceId, userId) join collection introduced for multi-account
 *  push fan-out. The DAO must be idempotent on upsert, scope-correct on lookup, and able to clear
 *  every row for a single device atomically (used by the 410 cleanup path). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import deviceUsersDAO from '../dataAccess/deviceUsersDAO.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await db.collection('deviceUsers').deleteMany({});
});

describe('deviceUsersDAO.upsert', () => {
    it('inserts a new row when the (deviceId, userId) pair is missing', async () => {
        await deviceUsersDAO.upsert('dev-1', 'user-1');

        const rows = await db.collection('deviceUsers').find({}).toArray();
        expect(rows).toHaveLength(1);
        expect(rows[0]?._id).toBe('dev-1:user-1');
        expect(rows[0]?.deviceId).toBe('dev-1');
        expect(rows[0]?.userId).toBe('user-1');
        expect(rows[0]?.createdTs).toBeTruthy();
        expect(rows[0]?.lastSeenTs).toBeTruthy();
    });

    it('is idempotent — calling upsert twice still produces a single row', async () => {
        await deviceUsersDAO.upsert('dev-1', 'user-1');
        await deviceUsersDAO.upsert('dev-1', 'user-1');

        const rows = await db.collection('deviceUsers').find({}).toArray();
        expect(rows).toHaveLength(1);
    });

    it('refreshes lastSeenTs on a repeat upsert without rewriting createdTs', async () => {
        await deviceUsersDAO.upsert('dev-1', 'user-1');
        const original = await db.collection('deviceUsers').findOne({ _id: 'dev-1:user-1' });
        // Sleep so the next upsert produces a strictly later ISO timestamp
        await new Promise((r) => setTimeout(r, 5));
        await deviceUsersDAO.upsert('dev-1', 'user-1');
        const refreshed = await db.collection('deviceUsers').findOne({ _id: 'dev-1:user-1' });

        expect(refreshed?.createdTs).toBe(original?.createdTs);
        // lastSeenTs must monotonically advance — verifies the upsert touched it
        expect(refreshed?.lastSeenTs > (original?.lastSeenTs as string)).toBe(true);
    });

    it('treats the same deviceId with different userIds as separate rows', async () => {
        await deviceUsersDAO.upsert('dev-1', 'user-a');
        await deviceUsersDAO.upsert('dev-1', 'user-b');

        const rows = await db.collection('deviceUsers').find({ deviceId: 'dev-1' }).toArray();
        expect(rows).toHaveLength(2);
    });
});

describe('deviceUsersDAO.remove', () => {
    it('removes only the (deviceId, userId) row asked for', async () => {
        await deviceUsersDAO.upsert('dev-1', 'user-a');
        await deviceUsersDAO.upsert('dev-1', 'user-b');

        await deviceUsersDAO.remove('dev-1', 'user-a');

        const rows = await db.collection('deviceUsers').find({ deviceId: 'dev-1' }).toArray();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.userId).toBe('user-b');
    });

    it('is a no-op when the row does not exist', async () => {
        await expect(deviceUsersDAO.remove('dev-missing', 'user-missing')).resolves.toBeUndefined();
    });
});

describe('deviceUsersDAO.removeAllForDevice', () => {
    it('removes every row for a single device while leaving other devices untouched', async () => {
        await deviceUsersDAO.upsert('dev-1', 'user-a');
        await deviceUsersDAO.upsert('dev-1', 'user-b');
        await deviceUsersDAO.upsert('dev-2', 'user-a');

        await deviceUsersDAO.removeAllForDevice('dev-1');

        expect(await db.collection('deviceUsers').countDocuments({ deviceId: 'dev-1' })).toBe(0);
        expect(await db.collection('deviceUsers').countDocuments({ deviceId: 'dev-2' })).toBe(1);
    });
});

describe('deviceUsersDAO.findUsersByDevice', () => {
    it('returns every user hosted on a device (in any order)', async () => {
        await deviceUsersDAO.upsert('dev-1', 'user-a');
        await deviceUsersDAO.upsert('dev-1', 'user-b');
        await deviceUsersDAO.upsert('dev-2', 'user-c');

        const rows = await deviceUsersDAO.findUsersByDevice('dev-1');
        expect(rows.map((r) => r.userId).sort()).toEqual(['user-a', 'user-b']);
    });

    it('returns an empty array when no rows exist for the device', async () => {
        await deviceUsersDAO.upsert('dev-other', 'user-a');
        const rows = await deviceUsersDAO.findUsersByDevice('dev-empty');
        expect(rows).toEqual([]);
    });
});

describe('deviceUsersDAO.findDevicesByUser', () => {
    it('returns every device hosting a given user', async () => {
        await deviceUsersDAO.upsert('dev-1', 'user-a');
        await deviceUsersDAO.upsert('dev-2', 'user-a');
        await deviceUsersDAO.upsert('dev-3', 'user-b');

        const rows = await deviceUsersDAO.findDevicesByUser('user-a');
        expect(rows.map((r) => r.deviceId).sort()).toEqual(['dev-1', 'dev-2']);
    });

    it('does not leak rows belonging to other users', async () => {
        await deviceUsersDAO.upsert('dev-1', 'user-a');
        await deviceUsersDAO.upsert('dev-1', 'user-b');

        const aRows = await deviceUsersDAO.findDevicesByUser('user-a');
        // Cross-user isolation: even with a shared deviceId, user-a's lookup must not surface user-b's row
        expect(aRows).toHaveLength(1);
        expect(aRows[0]?.userId).toBe('user-a');
    });
});
