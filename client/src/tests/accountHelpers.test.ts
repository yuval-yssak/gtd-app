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
} from '../db/accountHelpers';
import type { MyDB, StoredAccount } from '../types/MyDB';
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
