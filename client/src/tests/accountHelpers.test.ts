import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    clearAllAccounts,
    getActiveAccount,
    getAllAccounts,
    getLoggedInAccounts,
    getLoggedInUserIds,
    removeAccount,
    setActiveAccount,
    upsertAccount,
    wipeUserData,
} from '../db/accountHelpers';
import type { MyDB, StoredAccount, StoredItem, StoredPerson, StoredRoutine, StoredWorkContext, SyncOperation } from '../types/MyDB';
import { openTestDB } from './openTestDB';

function makeAccount(id: string, addedAt: number, overrides: Partial<StoredAccount> = {}): StoredAccount {
    return {
        id,
        email: `${id}@example.com`,
        name: `User ${id}`,
        image: null,
        provider: 'google',
        addedAt,
        ...overrides,
    };
}

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    db = await openTestDB();
});

afterEach(() => {
    db.close();
});

// ── upsertAccount ─────────────────────────────────────────────────────────────

describe('upsertAccount', () => {
    it('inserts a new account', async () => {
        const account = makeAccount('u1', 1000);
        await upsertAccount(account, db);

        const stored = await db.get('accounts', 'u1');
        expect(stored).toEqual(account);
    });

    it('overwrites an existing account with the same id', async () => {
        await upsertAccount(makeAccount('u1', 1000), db);
        const updated = makeAccount('u1', 1000, { name: 'Updated Name' });
        await upsertAccount(updated, db);

        const stored = await db.get('accounts', 'u1');
        expect(stored?.name).toBe('Updated Name');

        const all = await db.getAll('accounts');
        expect(all).toHaveLength(1);
    });

    it('reconciles a same-email row under a new id instead of throwing ConstraintError', async () => {
        // Re-login where the email now maps to a different userId. The store is keyed by `id` but
        // `email` is uniquely indexed — a plain put would throw ConstraintError. upsertAccount must
        // replace the stale-id row so the same email never collides across two primary keys.
        await upsertAccount(makeAccount('old-id', 1000, { email: 'same@example.com' }), db);
        await upsertAccount(makeAccount('new-id', 2000, { email: 'same@example.com' }), db);

        expect(await db.get('accounts', 'old-id')).toBeUndefined();
        expect((await db.get('accounts', 'new-id'))?.email).toBe('same@example.com');

        const all = await db.getAll('accounts');
        expect(all).toHaveLength(1);
    });

    it('leaves a different-email account untouched when upserting a new account', async () => {
        await upsertAccount(makeAccount('u1', 1000, { email: 'a@example.com' }), db);
        await upsertAccount(makeAccount('u2', 2000, { email: 'b@example.com' }), db);

        const all = await getAllAccounts(db);
        expect(all.map((a) => a.id)).toEqual(['u1', 'u2']);
    });

    it('does not repoint activeAccount when reconciling a same-email row (caller owns that)', async () => {
        // Documents the deliberate single-responsibility boundary: reconciling the stale-id row leaves
        // the activeAccount pointer dangling at the old id; the re-login caller's setActiveAccount is
        // what re-points it. getActiveAccount returns undefined in the interim (pointer → deleted row).
        await upsertAccount(makeAccount('old-id', 1000, { email: 'same@example.com' }), db);
        await setActiveAccount('old-id', db);

        await upsertAccount(makeAccount('new-id', 2000, { email: 'same@example.com' }), db);

        expect(await db.get('activeAccount', 'active')).toEqual({ userId: 'old-id' });
        expect(await getActiveAccount(db)).toBeUndefined();
    });
});

// ── setActiveAccount / getActiveAccount ───────────────────────────────────────

describe('setActiveAccount / getActiveAccount', () => {
    it('returns undefined when no active account is set', async () => {
        expect(await getActiveAccount(db)).toBeUndefined();
    });

    it('returns the account matching the active userId', async () => {
        const account = makeAccount('u1', 1000);
        await upsertAccount(account, db);
        await setActiveAccount('u1', db);

        const active = await getActiveAccount(db);
        expect(active).toEqual(account);
    });

    it('returns undefined when active points to a non-existent account', async () => {
        await setActiveAccount('ghost', db);
        expect(await getActiveAccount(db)).toBeUndefined();
    });
});

// ── getAllAccounts ─────────────────────────────────────────────────────────────

describe('getAllAccounts', () => {
    it('returns empty array when no accounts exist', async () => {
        expect(await getAllAccounts(db)).toEqual([]);
    });

    it('returns accounts sorted by addedAt ascending', async () => {
        await upsertAccount(makeAccount('u2', 2000), db);
        await upsertAccount(makeAccount('u1', 1000), db);
        await upsertAccount(makeAccount('u3', 3000), db);

        const all = await getAllAccounts(db);
        expect(all.map((a) => a.id)).toEqual(['u1', 'u2', 'u3']);
    });
});

// ── removeAccount ─────────────────────────────────────────────────────────────

describe('removeAccount', () => {
    it('deletes the account from the store', async () => {
        await upsertAccount(makeAccount('u1', 1000), db);
        await removeAccount('u1', db);

        expect(await db.get('accounts', 'u1')).toBeUndefined();
    });

    it('clears active account when the removed account was active', async () => {
        await upsertAccount(makeAccount('u1', 1000), db);
        await setActiveAccount('u1', db);
        await removeAccount('u1', db);

        expect(await getActiveAccount(db)).toBeUndefined();
    });

    it('preserves active account when a different account is removed', async () => {
        await upsertAccount(makeAccount('u1', 1000), db);
        await upsertAccount(makeAccount('u2', 2000), db);
        await setActiveAccount('u1', db);
        await removeAccount('u2', db);

        const active = await getActiveAccount(db);
        expect(active?.id).toBe('u1');
    });
});

// ── clearAllAccounts ──────────────────────────────────────────────────────────

describe('clearAllAccounts', () => {
    it('removes all accounts and clears active account', async () => {
        await upsertAccount(makeAccount('u1', 1000), db);
        await upsertAccount(makeAccount('u2', 2000), db);
        await setActiveAccount('u1', db);

        await clearAllAccounts(db);

        expect(await getAllAccounts(db)).toEqual([]);
        expect(await getActiveAccount(db)).toBeUndefined();
    });
});

// ── getLoggedInAccounts / getLoggedInUserIds ─────────────────────────────────

describe('getLoggedInAccounts', () => {
    it('returns every account in oldest-added order', async () => {
        await upsertAccount(makeAccount('u2', 2000), db);
        await upsertAccount(makeAccount('u1', 1000), db);

        const accounts = await getLoggedInAccounts(db);
        expect(accounts.map((a) => a.id)).toEqual(['u1', 'u2']);
    });

    it('returns an empty array when no accounts exist', async () => {
        expect(await getLoggedInAccounts(db)).toEqual([]);
    });
});

describe('getLoggedInUserIds', () => {
    it('returns every user id in oldest-added order', async () => {
        await upsertAccount(makeAccount('u2', 2000), db);
        await upsertAccount(makeAccount('u1', 1000), db);

        expect(await getLoggedInUserIds(db)).toEqual(['u1', 'u2']);
    });

    it('returns an empty array when no accounts exist', async () => {
        expect(await getLoggedInUserIds(db)).toEqual([]);
    });
});

// ── wipeUserData ──────────────────────────────────────────────────────────────

function makeItem(id: string, userId: string): StoredItem {
    return {
        _id: id,
        userId,
        status: 'inbox',
        title: `item-${id}`,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
    };
}

function makeRoutine(id: string, userId: string): StoredRoutine {
    return {
        _id: id,
        userId,
        title: `routine-${id}`,
        routineType: 'nextAction',
        rrule: 'FREQ=DAILY',
        template: {},
        active: true,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
    };
}

function makePerson(id: string, userId: string): StoredPerson {
    return {
        _id: id,
        userId,
        name: `person-${id}`,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
    };
}

function makeWorkContext(id: string, userId: string): StoredWorkContext {
    return {
        _id: id,
        userId,
        name: `ctx-${id}`,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
    };
}

function makeSyncOp(userId: string, entityId: string): Omit<SyncOperation, 'id'> {
    return {
        userId,
        entityType: 'item',
        entityId,
        opType: 'create',
        queuedAt: '2026-01-01T00:00:00.000Z',
        snapshot: makeItem(entityId, userId),
    };
}

async function seedTwoUsersData() {
    // user A
    await db.put('items', makeItem('itemA1', 'userA'));
    await db.put('items', makeItem('itemA2', 'userA'));
    await db.put('routines', makeRoutine('rA1', 'userA'));
    await db.put('people', makePerson('pA1', 'userA'));
    await db.put('workContexts', makeWorkContext('cA1', 'userA'));
    await db.put('syncCursors', { userId: 'userA', lastSyncedTs: '2026-01-01T00:00:00.000Z', lastSyncedId: '' });
    await db.add('syncOperations', makeSyncOp('userA', 'itemA1') as SyncOperation);
    await db.add('syncOperations', makeSyncOp('userA', 'itemA2') as SyncOperation);
    // user B (must survive the wipe of A)
    await db.put('items', makeItem('itemB1', 'userB'));
    await db.put('routines', makeRoutine('rB1', 'userB'));
    await db.put('people', makePerson('pB1', 'userB'));
    await db.put('workContexts', makeWorkContext('cB1', 'userB'));
    await db.put('syncCursors', { userId: 'userB', lastSyncedTs: '2026-01-02T00:00:00.000Z', lastSyncedId: '' });
    await db.add('syncOperations', makeSyncOp('userB', 'itemB1') as SyncOperation);
    // device meta — must never be touched
    await db.put('deviceMeta', { _id: 'local', deviceId: 'device-1', flushingTs: null });
}

describe('wipeUserData', () => {
    it('removes the target user rows from items/routines/people/workContexts', async () => {
        await seedTwoUsersData();
        await wipeUserData('userA', db);

        expect(await db.getAllFromIndex('items', 'userId', 'userA')).toEqual([]);
        expect(await db.getAllFromIndex('routines', 'userId', 'userA')).toEqual([]);
        expect(await db.getAllFromIndex('people', 'userId', 'userA')).toEqual([]);
        expect(await db.getAllFromIndex('workContexts', 'userId', 'userA')).toEqual([]);
    });

    it('preserves the other user rows untouched', async () => {
        await seedTwoUsersData();
        await wipeUserData('userA', db);

        expect((await db.getAllFromIndex('items', 'userId', 'userB')).map((i) => i._id)).toEqual(['itemB1']);
        expect((await db.getAllFromIndex('routines', 'userId', 'userB')).map((r) => r._id)).toEqual(['rB1']);
        expect((await db.getAllFromIndex('people', 'userId', 'userB')).map((p) => p._id)).toEqual(['pB1']);
        expect((await db.getAllFromIndex('workContexts', 'userId', 'userB')).map((c) => c._id)).toEqual(['cB1']);
    });

    it('deletes only the target user row from syncCursors', async () => {
        await seedTwoUsersData();
        await wipeUserData('userA', db);

        expect(await db.get('syncCursors', 'userA')).toBeUndefined();
        expect(await db.get('syncCursors', 'userB')).toEqual({ userId: 'userB', lastSyncedTs: '2026-01-02T00:00:00.000Z', lastSyncedId: '' });
    });

    it('drops only the target user rows from syncOperations', async () => {
        await seedTwoUsersData();
        await wipeUserData('userA', db);

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        expect(ops[0]?.userId).toBe('userB');
        expect(ops[0]?.entityId).toBe('itemB1');
    });

    it('preserves deviceMeta', async () => {
        await seedTwoUsersData();
        await wipeUserData('userA', db);

        expect(await db.get('deviceMeta', 'local')).toEqual({ _id: 'local', deviceId: 'device-1', flushingTs: null });
    });

    it('preserves the accounts directory', async () => {
        // wipeUserData is the entity-data wipe; account directory teardown is the caller's job.
        await upsertAccount(makeAccount('userA', 1000), db);
        await upsertAccount(makeAccount('userB', 2000), db);
        await seedTwoUsersData();

        await wipeUserData('userA', db);

        const accounts = await getAllAccounts(db);
        expect(accounts.map((a) => a.id)).toEqual(['userA', 'userB']);
    });

    it('is a no-op for an unknown userId', async () => {
        await seedTwoUsersData();
        await wipeUserData('ghost', db);

        // Every previously-seeded row is still there.
        expect(await db.getAllFromIndex('items', 'userId', 'userA')).toHaveLength(2);
        expect(await db.getAllFromIndex('items', 'userId', 'userB')).toHaveLength(1);
        expect(await db.get('syncCursors', 'userA')).toBeDefined();
        expect(await db.get('syncCursors', 'userB')).toBeDefined();
        expect(await db.getAll('syncOperations')).toHaveLength(3);
    });
});
