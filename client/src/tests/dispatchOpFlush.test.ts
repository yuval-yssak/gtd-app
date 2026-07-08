import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

vi.mock('../db/multiUserSync', () => ({
    syncSingleUser: vi.fn().mockResolvedValue(undefined),
}));

import { fetchSyncOps, pushSyncOps, SyncAuthError } from '#api/syncClient';
import { ACCOUNT_NEEDS_REAUTH_EVENT } from '../contexts/accountReauthEvents';
import { dispatchOpFlush } from '../db/dispatchOpFlush';
import { syncSingleUser } from '../db/multiUserSync';
import type { MyDB } from '../types/MyDB';
import { openTestDB } from './openTestDB';

let db: IDBPDatabase<MyDB>;

async function seedAccount(idbDb: IDBPDatabase<MyDB>, id: string, email: string): Promise<void> {
    await idbDb.put('accounts', {
        id,
        email,
        name: email,
        image: null,
        provider: 'google',
        addedAt: dayjs().valueOf(),
    });
}

beforeEach(async () => {
    db = await openTestDB();
    await db.put('deviceMeta', { _id: 'local', deviceId: 'dev-test', flushingTs: null });
    vi.mocked(fetchSyncOps).mockResolvedValue({ ops: [], serverTs: '2025-01-02T00:00:00.000Z', serverId: '' });
});

afterEach(() => {
    vi.clearAllMocks();
    db.close();
});

describe('dispatchOpFlush', () => {
    it('delegates to syncSingleUser when the op belongs to a non-active account', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        await dispatchOpFlush(db, 'user-b');

        expect(syncSingleUser).toHaveBeenCalledWith(db, 'user-b');
    });

    it('flags the account for reauth on a 401 on the same-account fast path, without throwing', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        vi.mocked(pushSyncOps).mockRejectedValueOnce(new SyncAuthError('POST /sync/push'));
        await db.add('syncOperations', {
            userId: 'user-a',
            opType: 'create',
            entityType: 'item',
            entityId: 'item-1',
            queuedAt: '2025-01-01T00:00:00.000Z',
            snapshot: null,
        });

        const dispatchSpy = vi.fn();
        vi.stubGlobal('window', { dispatchEvent: dispatchSpy } as unknown as Window);

        await expect(dispatchOpFlush(db, 'user-a')).resolves.toBeUndefined();

        const reauthEvents = dispatchSpy.mock.calls.map(([e]) => e as CustomEvent).filter((e) => e.type === ACCOUNT_NEEDS_REAUTH_EVENT);
        expect(reauthEvents).toHaveLength(1);
        const [reauthEvent] = reauthEvents;
        if (!reauthEvent) throw new Error('expected one reauth event');
        expect(reauthEvent.detail).toEqual({ userId: 'user-a' });

        vi.unstubAllGlobals();
    });

    it('rethrows non-auth errors on the same-account fast path', async () => {
        await seedAccount(db, 'user-a', 'a@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        vi.mocked(pushSyncOps).mockRejectedValueOnce(new Error('POST /sync/push 500'));
        await db.add('syncOperations', {
            userId: 'user-a',
            opType: 'create',
            entityType: 'item',
            entityId: 'item-1',
            queuedAt: '2025-01-01T00:00:00.000Z',
            snapshot: null,
        });

        await expect(dispatchOpFlush(db, 'user-a')).rejects.toThrow('POST /sync/push 500');
    });
});
