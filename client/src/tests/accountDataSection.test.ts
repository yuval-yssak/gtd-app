import { describe, expect, it, vi } from 'vitest';
import { AccountApiError } from '../api/accountApi';
import { isDeleteConfirmationValid, runAccountDeletion, SESSION_MISMATCH_MESSAGE } from '../components/settings/accountDataSectionLogic';

describe('isDeleteConfirmationValid', () => {
    it('accepts the exact email', () => {
        expect(isDeleteConfirmationValid('alice@example.com', 'alice@example.com')).toBe(true);
    });

    it('ignores case and surrounding whitespace — a stray space must not block a deliberate user', () => {
        expect(isDeleteConfirmationValid('  Alice@Example.COM ', 'alice@example.com')).toBe(true);
    });

    it('rejects a different address, a partial match and an empty field', () => {
        expect(isDeleteConfirmationValid('bob@example.com', 'alice@example.com')).toBe(false);
        expect(isDeleteConfirmationValid('alice@example', 'alice@example.com')).toBe(false);
        expect(isDeleteConfirmationValid('', 'alice@example.com')).toBe(false);
        expect(isDeleteConfirmationValid('   ', 'alice@example.com')).toBe(false);
    });

    it('never accepts an empty confirmation even if the account email were empty', () => {
        expect(isDeleteConfirmationValid('', '')).toBe(false);
    });
});

describe('runAccountDeletion', () => {
    const account = { id: 'user-a' };
    /** Records call order so the test can prove the evaporation ran AFTER the pivoted call released. */
    function makeDeps(deleteImpl: (expectedUserId: string) => Promise<{ deletedUserId: string }>) {
        const order: string[] = [];
        const deleteMyAccount = vi.fn(async (expectedUserId: string) => {
            order.push('delete');
            return deleteImpl(expectedUserId);
        });
        // A plain generic function, not vi.fn — a Mock erases <T> to unknown, which no longer satisfies
        // the dependency's `<T>(task) => Promise<T>` signature. The `order` log is the assertion surface.
        const withActiveAccountSession = async <T>(task: () => Promise<T>): Promise<T> => {
            order.push('pivot-in');
            try {
                return await task();
            } finally {
                order.push('pivot-out');
            }
        };
        const evaporate = vi.fn(async (userId: string) => {
            order.push(`evaporate:${userId}`);
        });
        return { order, deleteMyAccount, withActiveAccountSession, evaporate };
    }

    it('happy path: deletes under the pivoted session, then evaporates the account OUTSIDE the pivot', async () => {
        const deps = makeDeps(async () => ({ deletedUserId: 'user-a' }));

        const result = await runAccountDeletion({ account, ...deps });

        expect(result).toEqual({ kind: 'deleted' });
        expect(deps.deleteMyAccount).toHaveBeenCalledExactlyOnceWith('user-a');
        expect(deps.order).toEqual(['pivot-in', 'delete', 'pivot-out', 'evaporate:user-a']);
    });

    it('409 session_mismatch: reports mismatch and evaporates nothing', async () => {
        const deps = makeDeps(async () => {
            throw new AccountApiError(409, 'mismatch', { code: 'session_mismatch', sessionUserId: 'user-b' });
        });

        const result = await runAccountDeletion({ account, ...deps });

        expect(result).toEqual({ kind: 'mismatch', message: SESSION_MISMATCH_MESSAGE });
        expect(deps.evaporate).not.toHaveBeenCalled();
    });

    it('server deleted a different account than asked: evaporates THAT one and reports mismatch, never the survivor', async () => {
        const deps = makeDeps(async () => ({ deletedUserId: 'user-b' }));

        const result = await runAccountDeletion({ account, ...deps });

        expect(result).toEqual({ kind: 'mismatch', message: SESSION_MISMATCH_MESSAGE });
        expect(deps.evaporate).toHaveBeenCalledExactlyOnceWith('user-b');
    });

    it('any other failure: reports failed with the error message and evaporates nothing', async () => {
        const deps = makeDeps(async () => {
            throw new AccountApiError(500, 'boom');
        });

        const result = await runAccountDeletion({ account, ...deps });

        expect(result).toEqual({ kind: 'failed', message: 'boom' });
        expect(deps.evaporate).not.toHaveBeenCalled();
    });

    it('falls back to a generic message when the failure carries none', async () => {
        const deps = makeDeps(async () => {
            throw new Error('');
        });
        const result = await runAccountDeletion({ account, ...deps });
        expect(result).toEqual({ kind: 'failed', message: "Couldn't delete the account. Please try again." });
    });
});
