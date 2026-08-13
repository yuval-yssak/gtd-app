import dayjs from 'dayjs';
import { describe, expect, it, vi } from 'vitest';
import { startReauthForAccount } from '../hooks/useAccounts';
import type { StoredAccount } from '../types/MyDB';

function account(id: string, provider: StoredAccount['provider']): StoredAccount {
    return { id, email: `${id}@example.com`, name: id, image: null, provider, addedAt: dayjs().valueOf() };
}

describe('startReauthForAccount', () => {
    it('starts sign-in with the matching account and returns true when the account is known', () => {
        const accounts = [account('user-a', 'google'), account('user-b', 'github')];
        const startSignIn = vi.fn();

        const result = startReauthForAccount(accounts, 'user-b', startSignIn);

        expect(result).toBe(true);
        expect(startSignIn).toHaveBeenCalledTimes(1);
        // The whole account is handed over — the caller needs provider AND email (login_hint) so
        // the OAuth re-login lands on the broken account, not whichever one Google has signed in.
        expect(startSignIn).toHaveBeenCalledWith(accounts[1]);
    });

    it('returns false and does not sign in when the account is not known locally', () => {
        const accounts = [account('user-a', 'google')];
        const startSignIn = vi.fn();

        const result = startReauthForAccount(accounts, 'user-z', startSignIn);

        expect(result).toBe(false);
        expect(startSignIn).not.toHaveBeenCalled();
    });
});
