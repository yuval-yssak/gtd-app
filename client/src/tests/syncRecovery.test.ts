import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

vi.mock('../lib/authClient', () => {
    const setActive = vi.fn(async () => undefined);
    const listDeviceSessions = vi.fn(async () => ({
        data: [
            { user: { id: 'user-a' }, session: { token: 'token-a' } },
            { user: { id: 'user-b' }, session: { token: 'token-b' } },
        ],
    }));
    return {
        authClient: {
            multiSession: { setActive, listDeviceSessions },
        },
    };
});

import dayjs from 'dayjs';
import { BootstrapRequiredError, fetchBootstrap, fetchDeviceStatus, fetchSyncOps, pushSyncOps } from '#api/syncClient';
import { getSyncRecoveryState, resetSyncRecoveryStoreForTests, subscribeSyncRecovery } from '../contexts/syncRecoveryStore';
import { syncAllLoggedInUsers } from '../db/multiUserSync';
import { recoverFromBootstrapRequired } from '../db/syncRecovery';
import type { MyDB, StoredItem, SyncOperation } from '../types/MyDB';
import { openTestDB } from './openTestDB';

let db: IDBPDatabase<MyDB>;

function makeItem(id: string, userId: string): StoredItem {
    return { _id: id, userId, status: 'inbox', title: `Item ${id}`, createdTs: '2025-01-01T00:00:00.000Z', updatedTs: '2025-01-01T00:00:00.000Z' };
}

function makeQueuedOp(entityId: string, userId: string): SyncOperation {
    return {
        userId,
        opType: 'create',
        entityType: 'item',
        entityId,
        queuedAt: dayjs().toISOString(),
        snapshot: makeItem(entityId, userId),
    };
}

const EMPTY_BOOTSTRAP = {
    items: [],
    routines: [],
    people: [],
    workContexts: [],
    serverTs: '2025-06-01T00:00:00.000Z',
    serverId: '',
};

async function seedAccount(idbDb: IDBPDatabase<MyDB>, id: string, email: string): Promise<void> {
    await idbDb.put('accounts', { id, email, name: email, image: null, provider: 'google', addedAt: dayjs().valueOf() });
}

beforeEach(async () => {
    db = await openTestDB();
    await db.put('deviceMeta', { _id: 'local', deviceId: 'dev-test', flushingTs: null });
    await seedAccount(db, 'user-a', 'a@example.com');
    await db.put('activeAccount', { userId: 'user-a' }, 'active');
    await db.put('syncCursors', { userId: 'user-a', lastSyncedTs: '2025-01-01T00:00:00.000Z', lastSyncedId: '' });
    vi.mocked(fetchSyncOps).mockResolvedValue({ ops: [], serverTs: '2025-01-02T00:00:00.000Z', serverId: '' });
});

afterEach(() => {
    vi.clearAllMocks();
    resetSyncRecoveryStoreForTests();
    db.close();
});

describe('syncOneUser recovery branching (via syncAllLoggedInUsers)', () => {
    it('Case 1: empty queue + pull 409 → auto-bootstraps under the held gate and returns to idle', async () => {
        vi.mocked(fetchSyncOps).mockRejectedValueOnce(new BootstrapRequiredError('GET /sync/pull'));
        vi.mocked(fetchBootstrap).mockResolvedValueOnce(EMPTY_BOOTSTRAP);

        const observedPhases: string[] = [];
        subscribeSyncRecovery(() => observedPhases.push(getSyncRecoveryState().phase));

        await syncAllLoggedInUsers(db);

        // Empty queue ⇒ the device-status probe is skipped entirely.
        expect(vi.mocked(fetchDeviceStatus)).not.toHaveBeenCalled();
        expect(vi.mocked(fetchBootstrap)).toHaveBeenCalledTimes(1);
        // The dialog locked (case1Syncing) then released (idle) — never a Case-2 choice.
        expect(observedPhases).toEqual(['case1Syncing', 'idle']);
        // The bootstrap re-established the cursor at the snapshot's serverTs.
        const cursor = await db.get('syncCursors', 'user-a');
        expect(cursor?.lastSyncedTs).toBe(EMPTY_BOOTSTRAP.serverTs);
    });

    it('Case 1: bootstrap failure lands in bootstrapFailed instead of locking the app forever', async () => {
        vi.mocked(fetchSyncOps).mockRejectedValueOnce(new BootstrapRequiredError('GET /sync/pull'));
        vi.mocked(fetchBootstrap).mockRejectedValueOnce(new Error('GET /sync/bootstrap 500'));
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await syncAllLoggedInUsers(db);

        expect(getSyncRecoveryState()).toEqual({ phase: 'bootstrapFailed', userId: 'user-a', errorMessage: 'GET /sync/bootstrap 500' });
        errorSpy.mockRestore();
    });

    it('Case 2: queued ops + probe says unregistered → enters case2Choice WITHOUT flushing or pulling', async () => {
        await db.add('syncOperations', makeQueuedOp('op-1', 'user-a'));
        vi.mocked(fetchDeviceStatus).mockResolvedValueOnce({ registered: false });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await syncAllLoggedInUsers(db);

        // The whole point of probe-before-flush: the queued op must NOT have been auto-pushed.
        expect(vi.mocked(pushSyncOps)).not.toHaveBeenCalled();
        expect(vi.mocked(fetchSyncOps)).not.toHaveBeenCalled();
        expect(vi.mocked(fetchBootstrap)).not.toHaveBeenCalled();
        expect(getSyncRecoveryState()).toEqual({ phase: 'case2Choice', userId: 'user-a', queuedOpCount: 1 });
        // The queue survives untouched for the user's push/discard/export choice.
        expect(await db.getAll('syncOperations')).toHaveLength(1);
        warnSpy.mockRestore();
    });

    it('queued ops + probe says registered → normal flush + pull, no recovery state', async () => {
        await db.add('syncOperations', makeQueuedOp('op-1', 'user-a'));

        await syncAllLoggedInUsers(db);

        expect(vi.mocked(fetchDeviceStatus)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(pushSyncOps)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fetchSyncOps)).toHaveBeenCalledTimes(1);
        expect(getSyncRecoveryState()).toEqual({ phase: 'idle' });
    });

    it('probe network failure → proceeds with normal flush + pull (sync never blocks on the probe)', async () => {
        await db.add('syncOperations', makeQueuedOp('op-1', 'user-a'));
        vi.mocked(fetchDeviceStatus).mockRejectedValueOnce(new Error('network down'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await syncAllLoggedInUsers(db);

        expect(vi.mocked(pushSyncOps)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fetchSyncOps)).toHaveBeenCalledTimes(1);
        expect(getSyncRecoveryState()).toEqual({ phase: 'idle' });
        warnSpy.mockRestore();
    });

    it('belt-and-suspenders: pull 409 with ops queued at 409-time → case2Choice, no bootstrap', async () => {
        // The probe raced a reap: it said registered (default mock), the (empty) flush passed, and
        // an op landed in the queue while the pull was in flight — then the pull 409'd.
        vi.mocked(fetchSyncOps).mockImplementationOnce(async () => {
            await db.add('syncOperations', makeQueuedOp('op-during-pull', 'user-a'));
            throw new BootstrapRequiredError('GET /sync/pull');
        });

        await syncAllLoggedInUsers(db);

        expect(vi.mocked(fetchBootstrap)).not.toHaveBeenCalled();
        expect(getSyncRecoveryState()).toEqual({ phase: 'case2Choice', userId: 'user-a', queuedOpCount: 1 });
    });

    it('a second account is still synced normally after the first entered case2Choice', async () => {
        await seedAccount(db, 'user-b', 'b@example.com');
        await db.put('syncCursors', { userId: 'user-b', lastSyncedTs: '2025-01-01T00:00:00.000Z', lastSyncedId: '' });
        await db.add('syncOperations', makeQueuedOp('op-a', 'user-a'));
        // user-a's probe: unregistered → case2Choice. user-b has no queued ops, so no probe runs
        // for it and its pass proceeds normally.
        vi.mocked(fetchDeviceStatus).mockResolvedValueOnce({ registered: false });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await syncAllLoggedInUsers(db);

        expect(getSyncRecoveryState()).toEqual({ phase: 'case2Choice', userId: 'user-a', queuedOpCount: 1 });
        // Exactly one pull: user-b's. user-a's pass was skipped.
        expect(vi.mocked(fetchSyncOps)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(pushSyncOps)).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });
});

describe('recoverFromBootstrapRequired (gate NOT held — SSE pull path)', () => {
    it('Case 1: empty queue → bootstraps through the gated helper and unlocks', async () => {
        vi.mocked(fetchBootstrap).mockResolvedValueOnce(EMPTY_BOOTSTRAP);

        await recoverFromBootstrapRequired(db, 'user-a');

        expect(vi.mocked(fetchBootstrap)).toHaveBeenCalledTimes(1);
        expect(getSyncRecoveryState()).toEqual({ phase: 'idle' });
        const cursor = await db.get('syncCursors', 'user-a');
        expect(cursor?.lastSyncedTs).toBe(EMPTY_BOOTSTRAP.serverTs);
    });

    it('Case 2: queued ops → case2Choice without any network call', async () => {
        await db.add('syncOperations', makeQueuedOp('op-1', 'user-a'));

        await recoverFromBootstrapRequired(db, 'user-a');

        expect(vi.mocked(fetchBootstrap)).not.toHaveBeenCalled();
        expect(getSyncRecoveryState()).toEqual({ phase: 'case2Choice', userId: 'user-a', queuedOpCount: 1 });
    });
});
