import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

import { getReviewInboxesByUser } from '../db/reviewInboxHelpers';
import {
    createReviewInbox,
    DEFAULT_REVIEW_INBOX_NAMES,
    removeReviewInbox,
    reorderReviewInboxes,
    seedDefaultReviewInboxesIfEmpty,
    updateReviewInbox,
} from '../db/reviewInboxMutations';
import { waitForPendingFlush } from '../db/syncHelpers';
import type { MyDB } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const USER_ID = 'user-1';

let db: IDBPDatabase<MyDB>;

// The seed guard persists a per-user marker in localStorage, which node lacks — back it with a
// fresh Map per test so marker semantics are actually exercised (and isolated between tests).
function stubLocalStorage() {
    const backing = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => backing.get(key) ?? null,
        setItem: (key: string, value: string) => backing.set(key, value),
        removeItem: (key: string) => backing.delete(key),
    });
}

beforeEach(async () => {
    stubLocalStorage();
    db = await openTestDB();
});

afterEach(async () => {
    await waitForPendingFlush().catch(() => {});
    db.close();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe('createReviewInbox', () => {
    it('writes a review inbox to IDB and queues a create op', async () => {
        const inbox = await createReviewInbox(db, { userId: USER_ID, name: 'Email', order: 0 });

        expect(inbox.name).toBe('Email');
        expect(inbox.userId).toBe(USER_ID);
        expect(inbox.order).toBe(0);
        expect(inbox._id).toBeTruthy();

        const stored = await db.get('reviewInboxes', inbox._id);
        expect(stored).toEqual(inbox);

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        const [op] = ops;
        if (!op) throw new Error('expected one queued op');
        expect(op.opType).toBe('create');
        expect(op.entityType).toBe('reviewInbox');
        expect(op.snapshot).toEqual(inbox);
    });

    it('honours a caller-provided deterministic _id', async () => {
        const inbox = await createReviewInbox(db, { _id: `${USER_ID}:default-0`, userId: USER_ID, name: 'Email', order: 0 });
        expect(inbox._id).toBe(`${USER_ID}:default-0`);
    });
});

describe('updateReviewInbox', () => {
    it('updates the review inbox and queues an update op', async () => {
        const inbox = await createReviewInbox(db, { userId: USER_ID, name: 'Email', order: 0 });
        await db.clear('syncOperations');

        const updated = await updateReviewInbox(db, { ...inbox, name: 'Work Email' });

        expect(updated.name).toBe('Work Email');
        expect(updated.updatedTs >= inbox.updatedTs).toBe(true);

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        const [op] = ops;
        if (!op) throw new Error('expected one queued op');
        expect(op.opType).toBe('update');
        expect(op.snapshot).toEqual(updated);
    });
});

describe('removeReviewInbox', () => {
    it('removing a non-existent id falls back to the active account for the delete op owner', async () => {
        // With no stored row there is no userId to scope by — queueSyncOp resolves the active
        // account instead, which is what feeds sync-recovery's ENTITY_STORE_BY_TYPE cleanup.
        await db.put('accounts', { id: 'active-user', email: 'a@example.com', name: 'A', image: null, provider: 'google', addedAt: 1 });
        await db.put('activeAccount', { userId: 'active-user' }, 'active');

        await removeReviewInbox(db, 'never-existed');

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        const [op] = ops;
        if (!op) throw new Error('expected one queued op');
        expect(op.opType).toBe('delete');
        expect(op.userId).toBe('active-user');
    });

    it('deletes the review inbox from IDB and queues a delete op scoped to the owner', async () => {
        const inbox = await createReviewInbox(db, { userId: USER_ID, name: 'Email', order: 0 });
        await db.clear('syncOperations');

        await removeReviewInbox(db, inbox._id);

        expect(await db.get('reviewInboxes', inbox._id)).toBeUndefined();

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        const [op] = ops;
        if (!op) throw new Error('expected one queued op');
        expect(op.opType).toBe('delete');
        expect(op.snapshot).toBeNull();
        expect(op.userId).toBe(USER_ID);
    });
});

describe('sync-queue collapse for reviewInbox ops', () => {
    it('create → update collapses into a single create carrying the final snapshot', async () => {
        const inbox = await createReviewInbox(db, { userId: USER_ID, name: 'Email', order: 0 });
        const updated = await updateReviewInbox(db, { ...inbox, name: 'Work Email' });

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        const [op] = ops;
        if (!op) throw new Error('expected one queued op');
        expect(op.opType).toBe('create');
        expect(op.snapshot).toEqual(updated);
    });

    it('create → delete drops both ops — the entity never reached the server', async () => {
        const inbox = await createReviewInbox(db, { userId: USER_ID, name: 'Email', order: 0 });
        await removeReviewInbox(db, inbox._id);

        expect(await db.getAll('syncOperations')).toHaveLength(0);
    });
});

describe('reorderReviewInboxes', () => {
    it('a no-op reorder queues zero ops', async () => {
        const first = await createReviewInbox(db, { userId: USER_ID, name: 'Email', order: 0 });
        const second = await createReviewInbox(db, { userId: USER_ID, name: 'Tray', order: 1 });
        await db.clear('syncOperations');

        await reorderReviewInboxes(db, [first, second]);

        expect(await db.getAll('syncOperations')).toHaveLength(0);
    });

    it('re-stamps order by array position and only queues ops for moved rows', async () => {
        const first = await createReviewInbox(db, { userId: USER_ID, name: 'Email', order: 0 });
        const second = await createReviewInbox(db, { userId: USER_ID, name: 'Tray', order: 1 });
        const third = await createReviewInbox(db, { userId: USER_ID, name: 'Voice', order: 2 });
        await db.clear('syncOperations');

        await reorderReviewInboxes(db, [second, first, third]);

        const rows = await getReviewInboxesByUser(db, USER_ID);
        expect(rows.map((row) => row.name)).toEqual(['Tray', 'Email', 'Voice']);

        // third kept position 2 → no op for it
        const ops = await db.getAll('syncOperations');
        expect(ops.map((op) => op.entityId).sort()).toEqual([first._id, second._id].sort());
    });
});

describe('seedDefaultReviewInboxesIfEmpty', () => {
    it('seeds the starter buckets with deterministic per-user ids', async () => {
        const seeded = await seedDefaultReviewInboxesIfEmpty(db, USER_ID);

        expect(seeded.map((inbox) => inbox.name)).toEqual([...DEFAULT_REVIEW_INBOX_NAMES]);
        expect(seeded.map((inbox) => inbox._id)).toEqual([`${USER_ID}:default-0`, `${USER_ID}:default-1`, `${USER_ID}:default-2`]);

        const rows = await getReviewInboxesByUser(db, USER_ID);
        expect(rows).toHaveLength(DEFAULT_REVIEW_INBOX_NAMES.length);
    });

    it('does not seed when the user already has any inbox', async () => {
        await createReviewInbox(db, { userId: USER_ID, name: 'My only bucket', order: 0 });

        const result = await seedDefaultReviewInboxesIfEmpty(db, USER_ID);

        expect(result.map((inbox) => inbox.name)).toEqual(['My only bucket']);
        const rows = await getReviewInboxesByUser(db, USER_ID);
        expect(rows).toHaveLength(1);
    });

    it('is scoped per user — another user still gets seeded', async () => {
        await seedDefaultReviewInboxesIfEmpty(db, USER_ID);
        const other = await seedDefaultReviewInboxesIfEmpty(db, 'user-2');
        expect(other).toHaveLength(DEFAULT_REVIEW_INBOX_NAMES.length);
        expect((await getReviewInboxesByUser(db, USER_ID)).every((inbox) => inbox.userId === USER_ID)).toBe(true);
    });

    it('never re-seeds after the marker is set, even when the store is empty again', async () => {
        // The user deleting every bucket (locally applied via a pull) must not have them
        // resurrected by the next review start on this device.
        const seeded = await seedDefaultReviewInboxesIfEmpty(db, USER_ID);
        await Promise.all(seeded.map((inbox) => removeReviewInbox(db, inbox._id)));

        const result = await seedDefaultReviewInboxesIfEmpty(db, USER_ID);

        expect(result).toHaveLength(0);
        expect(await getReviewInboxesByUser(db, USER_ID)).toHaveLength(0);
    });

    it('sets the marker when finding an existing non-empty list, so a later wipe does not trigger a seed', async () => {
        // Rows that arrived via sync (created on another device) count as "this user has inboxes":
        // observing them must arm the marker exactly like seeding would.
        await createReviewInbox(db, { userId: USER_ID, name: 'Synced bucket', order: 0 });
        await seedDefaultReviewInboxesIfEmpty(db, USER_ID);

        // Simulate a sign-out wipe: the store empties but localStorage (deliberately) survives.
        await db.clear('reviewInboxes');

        const result = await seedDefaultReviewInboxesIfEmpty(db, USER_ID);
        expect(result).toHaveLength(0);
    });
});
