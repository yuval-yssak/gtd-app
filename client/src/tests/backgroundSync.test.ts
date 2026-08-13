import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

import dayjs from 'dayjs';
import { fetchSyncOps, pushSyncOps } from '#api/syncClient';
import { flushQueueForSessionUser, pullForSessionUser } from '../db/backgroundSync';
import type { MyDB } from '../types/MyDB';
import { openTestDB } from './openTestDB';

// The Service Worker's background sync must scope itself to the user the COOKIE authenticates as,
// never to IDB's `activeAccount` — the local-first account switch writes only IDB, so the two can
// legitimately diverge until a foreground tab runs reconcileActiveSessionCookie. These tests pin
// that invariant at the seam the SW uses (the session-user resolver is injected).

let db: IDBPDatabase<MyDB>;

async function queueOpFor(userId: string, entityId: string): Promise<void> {
    await db.add('syncOperations', {
        userId,
        opType: 'delete',
        entityType: 'item',
        entityId,
        queuedAt: dayjs().toISOString(),
        snapshot: null,
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

describe('flushQueueForSessionUser', () => {
    it('flushes only the session user’s ops even when IDB activeAccount points elsewhere (offline-switch drift)', async () => {
        // Offline switch happened: IDB says user-b is active, but the cookie still authenticates
        // as user-a. A queued delete for user-a must flush; user-b's op must NOT ride along.
        await db.put('activeAccount', { userId: 'user-b' }, 'active');
        await queueOpFor('user-a', 'a-item');
        await queueOpFor('user-b', 'b-item');

        const flushed = await flushQueueForSessionUser(db, async () => 'user-a');

        expect(flushed).toBe('user-a');
        const calls = vi.mocked(pushSyncOps).mock.calls;
        expect(calls).toHaveLength(1);
        const [call] = calls;
        if (!call) throw new Error('expected one push');
        const [, ops] = call;
        expect(ops.map((op) => op.entityId)).toEqual(['a-item']);
        // user-b's op stays queued for the post-reconcile foreground flush.
        const remaining = await db.getAll('syncOperations');
        expect(remaining.map((op) => op.entityId)).toEqual(['b-item']);
    });

    it('skips entirely when no session is reachable (offline / signed out)', async () => {
        await queueOpFor('user-a', 'a-item');

        const flushed = await flushQueueForSessionUser(db, async () => null);

        expect(flushed).toBeNull();
        expect(pushSyncOps).not.toHaveBeenCalled();
        expect(await db.getAll('syncOperations')).toHaveLength(1);
    });
});

async function seedAccount(userId: string, email: string): Promise<void> {
    await db.put('accounts', { id: userId, email, name: email, image: null, provider: 'google', addedAt: dayjs().valueOf() });
}

describe('pullForSessionUser', () => {
    it('pulls when the cookie session and IDB activeAccount agree', async () => {
        await seedAccount('user-a', 'a@example.com');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        await db.put('syncCursors', { userId: 'user-a', lastSyncedTs: '2025-01-01T00:00:00.000Z', lastSyncedId: '' });

        const outcome = await pullForSessionUser(db, async () => 'user-a');

        expect(outcome).toBe('pulled');
        expect(fetchSyncOps).toHaveBeenCalledTimes(1);
    });

    it('skips (no pull) when the cookie session and IDB activeAccount diverge — cursor corruption guard', async () => {
        await seedAccount('user-b', 'b@example.com');
        await db.put('activeAccount', { userId: 'user-b' }, 'active');
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const outcome = await pullForSessionUser(db, async () => 'user-a');

        expect(outcome).toBe('skipped_drift');
        expect(fetchSyncOps).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('skips when no session is reachable', async () => {
        const outcome = await pullForSessionUser(db, async () => null);
        expect(outcome).toBe('skipped_no_session');
        expect(fetchSyncOps).not.toHaveBeenCalled();
    });
});
