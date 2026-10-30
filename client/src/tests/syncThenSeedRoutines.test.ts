import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));
vi.mock('#api/accountApi', async () => await import('../api/accountApi.mock.ts'));

vi.mock('../lib/authClient', () => {
    const setActive = vi.fn(async () => undefined);
    const listDeviceSessions = vi.fn(async () => ({ data: [{ user: { id: 'user-a' }, session: { token: 'token-a' } }] }));
    const getSession = vi.fn(async () => ({ data: { user: { id: 'user-a' } } }));
    return { authClient: { getSession, multiSession: { setActive, listDeviceSessions } } };
});

import { fetchUserStatus } from '#api/accountApi';
import { fetchSyncOps, SyncAuthError } from '#api/syncClient';
import { resetAccountReauthStore } from '../contexts/accountReauthEvents';
import { resetUserStatusProbeThrottleForTests } from '../db/multiUserSync';
import { createRoutine } from '../db/routineMutations';
import { waitForPendingFlush } from '../db/syncHelpers';
import { syncThenSeedRoutines } from '../db/syncThenSeedRoutines';
import { authClient } from '../lib/authClient';
import type { MyDB } from '../types/MyDB';
import { openTestDB, seedAccountOnDevice } from './openTestDB';

const USER_ID = 'user-a';
const OTHER_USER_ID = 'user-b';

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    db = await openTestDB();
    await seedAccountOnDevice(db, USER_ID);
    await db.put('activeAccount', { userId: USER_ID }, 'active');
    await db.put('deviceMeta', { _id: 'local', deviceId: 'dev-test', flushingTs: null });
    await db.put('syncCursors', { userId: USER_ID, lastSyncedTs: '2025-01-01T00:00:00.000Z', lastSyncedId: '' });
    vi.mocked(fetchSyncOps).mockResolvedValue({ ops: [], serverTs: '2025-01-02T00:00:00.000Z', serverId: '' });
    vi.mocked(fetchUserStatus).mockResolvedValue({ status: 'active' });
    resetUserStatusProbeThrottleForTests();
});

afterEach(async () => {
    await waitForPendingFlush().catch(() => {});
    vi.clearAllMocks();
    resetAccountReauthStore();
    db.close();
});

/** An active nextAction routine with no open item — exactly what the seeding pass materializes. */
async function seedRoutineWithoutOpenItem() {
    const routine = await createRoutine(db, {
        userId: USER_ID,
        title: 'Get flowers',
        routineType: 'nextAction',
        rrule: 'FREQ=MONTHLY',
        template: {},
        active: true,
    });
    await db.clear('syncOperations');
    return routine;
}

async function routineItemCount(routineId: string) {
    const allItems = await db.getAllFromIndex('items', 'userId', USER_ID);
    return allItems.filter((i) => i.routineId === routineId).length;
}

describe('syncThenSeedRoutines', () => {
    it('seeds the first item of a routine with no open item after the account synced', async () => {
        const routine = await seedRoutineWithoutOpenItem();

        await syncThenSeedRoutines(db, USER_ID);

        expect(await routineItemCount(routine._id)).toBe(1);
    });

    it('seeds nothing when the account could not sync — its local view may be missing the open item', async () => {
        const routine = await seedRoutineWithoutOpenItem();
        vi.mocked(fetchSyncOps).mockRejectedValue(new SyncAuthError('401'));

        await syncThenSeedRoutines(db, USER_ID);

        expect(await routineItemCount(routine._id)).toBe(0);
    });

    it("seeds nothing when another account synced but the active account's own pass was skipped", async () => {
        const routine = await seedRoutineWithoutOpenItem();
        await seedAccountOnDevice(db, OTHER_USER_ID);
        await db.put('syncCursors', { userId: OTHER_USER_ID, lastSyncedTs: '2025-01-01T00:00:00.000Z', lastSyncedId: '' });
        vi.mocked(authClient.multiSession.listDeviceSessions).mockResolvedValueOnce({
            data: [
                { user: { id: USER_ID }, session: { token: 'token-a' } },
                { user: { id: OTHER_USER_ID }, session: { token: 'token-b' } },
            ],
        });
        // Passes run in account order: the active account's pull is rejected, the other's succeeds.
        vi.mocked(fetchSyncOps).mockRejectedValueOnce(new SyncAuthError('401'));
        const onUserSynced = vi.fn<(userId: string) => Promise<void>>(async () => undefined);

        await syncThenSeedRoutines(db, USER_ID, onUserSynced);

        expect(onUserSynced).toHaveBeenCalledExactlyOnceWith(OTHER_USER_ID);
        expect(await routineItemCount(routine._id)).toBe(0);
    });

    it('forwards each synced account to onUserSynced', async () => {
        const onUserSynced = vi.fn<(userId: string) => Promise<void>>(async () => undefined);

        await syncThenSeedRoutines(db, USER_ID, onUserSynced);

        expect(onUserSynced).toHaveBeenCalledExactlyOnceWith(USER_ID);
    });
});
