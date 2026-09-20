import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

import { clearBrief, setUserBrief } from '../db/itemBriefMutations';
import { queueSyncOp, waitForPendingFlush } from '../db/syncHelpers';
import { briefSourceHash, briefState } from '../lib/briefSource';
import type { MyDB, StoredItem } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const USER_ID = 'user-1';

function makeItem(overrides: Partial<StoredItem> = {}): StoredItem {
    return {
        _id: 'item-1',
        userId: USER_ID,
        status: 'nextAction',
        title: 'Renew passport',
        notes: 'Form is half filled; need photos.',
        createdTs: '2026-07-01T10:00:00.000Z',
        updatedTs: '2026-07-01T10:00:00.000Z',
        ...overrides,
    };
}

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    db = await openTestDB();
});

afterEach(async () => {
    await waitForPendingFlush().catch(() => {});
    db.close();
    vi.clearAllMocks();
});

/** setUserBrief returns null only for blank text — every non-blank write in these tests must yield a row. */
async function setBriefRow(item: StoredItem, text: string) {
    const brief = await setUserBrief(db, item, text);
    if (!brief) throw new Error('expected a stored brief row');
    return brief;
}

async function onlyQueuedOp() {
    const ops = await db.getAll('syncOperations');
    expect(ops).toHaveLength(1);
    const [op] = ops;
    if (!op) throw new Error('expected one queued op');
    return op;
}

describe('setUserBrief', () => {
    it('writes a user-origin row keyed by the item id, hashed from the CURRENT title + notes, and queues a create op', async () => {
        const item = makeItem();

        const brief = await setBriefRow(item, '  Passport before the June trip  ');

        expect(brief).toMatchObject({
            _id: item._id,
            itemId: item._id,
            userId: USER_ID,
            text: 'Passport before the June trip',
            origin: 'user',
            sourceHash: briefSourceHash(item.title, item.notes),
        });
        expect(brief.createdTs).toBe(brief.updatedTs);
        expect(brief.generatedTs).toBe(brief.updatedTs);
        expect(brief.model).toBeUndefined();
        expect(await db.get('itemBriefs', item._id)).toEqual(brief);

        const op = await onlyQueuedOp();
        expect(op).toMatchObject({ opType: 'create', entityType: 'itemBrief', entityId: item._id, userId: USER_ID });
        expect(op.snapshot).toEqual(brief);
    });

    it('reads as fresh against the item it was written for and pinnedStale once the notes move on', async () => {
        const item = makeItem();
        const brief = await setBriefRow(item, 'Passport before the June trip');

        expect(briefState(item, brief)).toBe('fresh');
        expect(briefState({ ...item, notes: 'Photos done, form still half filled.' }, brief)).toBe('pinnedStale');
    });

    it('re-stamps the hash from the item passed at write time, so an edited item re-pins its brief as fresh', async () => {
        const original = makeItem();
        await setUserBrief(db, original, 'First take');
        const edited = makeItem({ notes: 'Rewritten notes' });

        const brief = await setBriefRow(edited, 'Second take');

        expect(brief.sourceHash).toBe(briefSourceHash(edited.title, edited.notes));
        expect(briefState(edited, brief)).toBe('fresh');
    });

    it('a second write keeps createdTs, bumps updatedTs, and the pending create absorbs it (one op, final snapshot)', async () => {
        const item = makeItem();
        const first = await setBriefRow(item, 'First take');
        await new Promise((resolve) => setTimeout(resolve, 2));

        const second = await setBriefRow(item, 'Second take');

        expect(second.createdTs).toBe(first.createdTs);
        expect(second.updatedTs > first.updatedTs).toBe(true);
        const op = await onlyQueuedOp();
        expect(op.opType).toBe('create');
        expect(op.snapshot).toEqual(second);
    });

    it('queues an update op when the row already exists locally (e.g. arrived by sync)', async () => {
        const item = makeItem();
        await db.put('itemBriefs', {
            _id: item._id,
            itemId: item._id,
            userId: USER_ID,
            text: 'From another device',
            origin: 'user',
            sourceHash: 'stale',
            generatedTs: '2026-06-01T00:00:00.000Z',
            createdTs: '2026-06-01T00:00:00.000Z',
            updatedTs: '2026-06-01T00:00:00.000Z',
        });

        const brief = await setBriefRow(item, 'Rewritten here');

        expect(brief.createdTs).toBe('2026-06-01T00:00:00.000Z');
        const op = await onlyQueuedOp();
        expect(op.opType).toBe('update');
        expect(op.snapshot).toEqual(brief);
    });

    it('blank text is a clear: no row is stored and an existing one is removed (a stored brief always has visible text)', async () => {
        const item = makeItem();
        expect(await setUserBrief(db, item, '   ')).toBeNull();
        expect(await db.get('itemBriefs', item._id)).toBeUndefined();
        expect(await db.getAll('syncOperations')).toHaveLength(0);

        await setUserBrief(db, item, 'Something');
        await db.clear('syncOperations');
        expect(await setUserBrief(db, item, '')).toBeNull();
        expect(await db.get('itemBriefs', item._id)).toBeUndefined();
        expect((await onlyQueuedOp()).opType).toBe('delete');
    });

    it('a brief write leaves a pending item create for the same id intact (sidecar shares the item id)', async () => {
        const item = makeItem();
        await queueSyncOp(db, { opType: 'create', entityType: 'item', entityId: item._id, snapshot: item, userId: USER_ID });

        await setUserBrief(db, item, 'Passport before the June trip');
        await clearBrief(db, item._id);

        const ops = await db.getAll('syncOperations');
        expect(ops.map((op) => `${op.entityType}:${op.opType}`)).toEqual(['item:create']);
    });

    it('scopes the op to the item owner, not the active account', async () => {
        await db.put('accounts', { id: 'active-user', email: 'a@example.com', name: 'A', image: null, provider: 'google', addedAt: 1 });
        await db.put('activeAccount', { userId: 'active-user' }, 'active');

        await setUserBrief(db, makeItem({ userId: 'other-user' }), 'Belongs to the other account');

        expect((await onlyQueuedOp()).userId).toBe('other-user');
    });
});

describe('clearBrief', () => {
    it('deletes the row and queues a delete op scoped to the owner', async () => {
        const item = makeItem();
        await setUserBrief(db, item, 'Passport before the June trip');
        await db.clear('syncOperations');

        await clearBrief(db, item._id);

        expect(await db.get('itemBriefs', item._id)).toBeUndefined();
        const op = await onlyQueuedOp();
        expect(op).toMatchObject({ opType: 'delete', entityType: 'itemBrief', entityId: item._id, userId: USER_ID, snapshot: null });
    });

    it('is a no-op (no op queued) when there is no row to clear', async () => {
        await clearBrief(db, 'never-had-a-brief');

        expect(await db.getAll('syncOperations')).toHaveLength(0);
    });

    it('create → clear before any flush drops both ops — the row never reached the server', async () => {
        const item = makeItem();
        await setUserBrief(db, item, 'Passport before the June trip');

        await clearBrief(db, item._id);

        expect(await db.getAll('syncOperations')).toHaveLength(0);
    });
});
