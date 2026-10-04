import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import deletedUsersDAO from '../dataAccess/deletedUsersDAO.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { confirmationMatches, parseDeleteUserArgs, resolveTarget } from '../scripts/deleteUser.js';

beforeAll(async () => {
    await loadDataAccess('gtd_test_delete_user_cli');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([db.collection('user').deleteMany({}), db.collection('deletedUsers').deleteMany({})]);
});

describe('parseDeleteUserArgs', () => {
    it('accepts --email with the dry-run and yes flags', () => {
        expect(parseDeleteUserArgs(['--email', 'a@b.test', '--dry-run', '--yes'])).toEqual({ email: 'a@b.test', dryRun: true, yes: true });
    });

    it('accepts --user-id and defaults both flags to false', () => {
        expect(parseDeleteUserArgs(['--user-id', 'u1'])).toEqual({ userId: 'u1', dryRun: false, yes: false });
    });

    it('requires exactly one of --email / --user-id', () => {
        expect(() => parseDeleteUserArgs([])).toThrow(/--email <addr> or --user-id <id>/);
        expect(() => parseDeleteUserArgs(['--email', 'a@b.test', '--user-id', 'u1'])).toThrow(/not both/);
    });

    it('rejects a flag with a missing value', () => {
        expect(() => parseDeleteUserArgs(['--email', '--dry-run'])).toThrow(/requires a value/);
        expect(() => parseDeleteUserArgs(['--email'])).toThrow(/requires a value/);
    });
});

describe('confirmationMatches', () => {
    it('is case-insensitive and ignores surrounding whitespace', () => {
        expect(confirmationMatches('  Alice@Example.com ', 'alice@example.com')).toBe(true);
    });

    it('rejects a different address and an unknown email', () => {
        expect(confirmationMatches('bob@example.com', 'alice@example.com')).toBe(false);
        expect(confirmationMatches('alice@example.com', null)).toBe(false);
    });
});

describe('resolveTarget', () => {
    it('resolves --email to the user id (lowercased email)', async () => {
        await db.collection('user').insertOne({ _id: 'cli-user', email: 'cli@example.com' } as never);
        await expect(resolveTarget({ email: 'CLI@example.com', dryRun: false, yes: false })).resolves.toEqual({ userId: 'cli-user', email: 'cli@example.com' });
    });

    it('rejects an unknown --email', async () => {
        await expect(resolveTarget({ email: 'nobody@example.com', dryRun: false, yes: false })).rejects.toThrow(/No user found with email/);
    });

    it('accepts --user-id for a live user and for an already-tombstoned id (idempotent re-run)', async () => {
        await db.collection('user').insertOne({ _id: 'live-user', email: 'live@example.com' } as never);
        await deletedUsersDAO.upsertTombstone({ _id: 'gone-user', deletedAt: '2026-10-04T00:00:00.000Z' });
        await expect(resolveTarget({ userId: 'live-user', dryRun: false, yes: true })).resolves.toEqual({ userId: 'live-user', email: 'live@example.com' });
        await expect(resolveTarget({ userId: 'gone-user', dryRun: false, yes: true })).resolves.toEqual({ userId: 'gone-user', email: null });
    });

    it('refuses --user-id for an id with neither a user row nor a tombstone, so --yes cannot mint a tombstone for a typo', async () => {
        await expect(resolveTarget({ userId: 'typo-id', dryRun: false, yes: true })).rejects.toThrow(/No user \(or deletion record\) found/);
        expect(await deletedUsersDAO.findByUserId('typo-id')).toBeNull();
    });
});
