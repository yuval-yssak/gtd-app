/**
 * The client half of the server-written `claudeAsk` entity: it arrives through bootstrap and
 * incremental pull (same LWW rule as every entity), and the start endpoint's returned row is
 * applied through `applyServerClaudeAsk` — never queuing an op, because devices do not push it.
 */
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

import { fetchBootstrap, fetchSyncOps } from '#api/syncClient';
import type { ServerClaudeAskSnapshot } from '../api/claudeRoutineApi';
import { applyServerClaudeAsk, bootstrapFromServer, pullFromServer } from '../db/syncHelpers';
import type { MyDB, StoredClaudeAsk } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const USER_ID = 'user-1';

function serverAsk(overrides: Partial<ServerClaudeAskSnapshot> = {}): ServerClaudeAskSnapshot {
    return {
        _id: 'ask-1',
        user: USER_ID,
        itemId: 'item-1',
        prompt: 'Rename it',
        sessionId: 'session_1',
        sessionUrl: 'https://claude.ai/code/session_1',
        createdTs: '2026-11-21T10:00:00.000Z',
        updatedTs: '2026-11-21T10:00:00.000Z',
        ...overrides,
    };
}

function storedAsk(overrides: Partial<StoredClaudeAsk> = {}): StoredClaudeAsk {
    const { user: _user, ...rest } = serverAsk();
    return { ...rest, userId: USER_ID, ...overrides };
}

const REPORTED = { summary: 'Renamed it', outcome: 'completed' as const, reportedTs: '2026-11-21T10:05:00.000Z' };

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    db = await openTestDB();
    await db.put('deviceMeta', { _id: 'local', deviceId: 'device-test', flushingTs: null });
    await db.put('syncCursors', { userId: USER_ID, lastSyncedTs: '1970-01-01T00:00:00.000Z', lastSyncedId: '' });
    await db.put('accounts', { id: USER_ID, email: 'u@example.com', name: 'U', image: null, provider: 'google', addedAt: 1 });
    await db.put('activeAccount', { userId: USER_ID }, 'active');
});

afterEach(() => {
    db.close();
    vi.clearAllMocks();
});

describe('applyServerClaudeAsk', () => {
    it('stores the row with user remapped to userId and queues no sync op', async () => {
        await applyServerClaudeAsk(db, serverAsk());
        expect(await db.get('claudeAsks', 'ask-1')).toEqual(storedAsk());
        expect(await db.getAll('syncOperations')).toEqual([]);
    });

    it('an older snapshot never clobbers a newer local row (the result arrived first)', async () => {
        await db.put('claudeAsks', storedAsk({ result: REPORTED, updatedTs: '2026-11-21T10:05:00.000Z' }));
        await applyServerClaudeAsk(db, serverAsk());
        expect((await db.get('claudeAsks', 'ask-1'))?.result).toEqual(REPORTED);
    });
});

describe('claudeAsk through sync', () => {
    it('bootstrap stores the user Claude asks', async () => {
        vi.mocked(fetchBootstrap).mockResolvedValueOnce({
            items: [],
            routines: [],
            people: [],
            workContexts: [],
            claudeAsks: [serverAsk()],
            serverTs: '2026-11-21T10:00:00.000Z',
            serverId: '',
        });
        await bootstrapFromServer(db, USER_ID);
        expect(await db.getAllFromIndex('claudeAsks', 'itemId', 'item-1')).toEqual([storedAsk()]);
    });

    it('bootstrap from a server that predates Ask Claude (no claudeAsks field) stores nothing and does not fail', async () => {
        vi.mocked(fetchBootstrap).mockResolvedValueOnce({
            items: [],
            routines: [],
            people: [],
            workContexts: [],
            serverTs: '2026-11-21T10:00:00.000Z',
            serverId: '',
        });
        await bootstrapFromServer(db, USER_ID);
        expect(await db.getAll('claudeAsks')).toEqual([]);
        expect(await db.get('syncCursors', USER_ID)).toMatchObject({ lastSyncedTs: '2026-11-21T10:00:00.000Z' });
    });

    it('a pulled update carries the result onto the stored row, and a pulled delete removes it', async () => {
        await db.put('claudeAsks', storedAsk());
        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [{ entityType: 'claudeAsk', entityId: 'ask-1', opType: 'update', snapshot: serverAsk({ result: REPORTED, updatedTs: REPORTED.reportedTs }) }],
            serverTs: REPORTED.reportedTs,
            serverId: '',
        });
        await pullFromServer(db, USER_ID);
        expect((await db.get('claudeAsks', 'ask-1'))?.result).toEqual(REPORTED);

        vi.mocked(fetchSyncOps).mockResolvedValueOnce({
            ops: [{ entityType: 'claudeAsk', entityId: 'ask-1', opType: 'delete', snapshot: null }],
            serverTs: '2026-11-21T10:06:00.000Z',
            serverId: '',
        });
        await pullFromServer(db, USER_ID);
        expect(await db.get('claudeAsks', 'ask-1')).toBeUndefined();
    });
});
