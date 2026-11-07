import { afterEach, describe, expect, it } from 'vitest';
import {
    accountToRestore,
    intendedActiveUserId,
    isPivotAllowed,
    recordAccountChoice,
    resetAccountChoicesForTests,
    whilePivoting,
    withdrawAccountChoice,
} from '../db/activeAccountChoice';
import { deferred } from './deferred';

afterEach(() => {
    resetAccountChoicesForTests();
});

/** Starts a pass that stays in flight until the returned `end()` is awaited. */
function passInFlight(startingUserId: string) {
    const passEnds = deferred();
    const pass = whilePivoting(startingUserId, () => passEnds.promise);
    return async () => {
        passEnds.resolve();
        await pass;
    };
}

describe('accountToRestore', () => {
    it('hands back the starting account when the user picked nothing', () => {
        expect(accountToRestore('user-a')).toBe('user-a');
    });

    it("hands the device to the user's pick, even one naming the account being synced", () => {
        recordAccountChoice('user-b');

        expect(accountToRestore('user-a')).toBe('user-b');
    });

    it('the latest of several picks wins', () => {
        recordAccountChoice('user-b');
        recordAccountChoice('user-c');

        expect(accountToRestore('user-a')).toBe('user-c');
    });

    it('goes back to the starting account once a failed switch withdraws its pick', () => {
        recordAccountChoice('user-b');
        withdrawAccountChoice();

        expect(accountToRestore('user-a')).toBe('user-a');
    });
});

describe('isPivotAllowed', () => {
    it('allows pivots until the user picks an account, and again once the pick is withdrawn', () => {
        expect(isPivotAllowed()).toBe(true);

        recordAccountChoice('user-a');
        expect(isPivotAllowed()).toBe(false);

        withdrawAccountChoice();
        expect(isPivotAllowed()).toBe(true);
    });
});

describe('intendedActiveUserId', () => {
    it('is the stored account when no pass is pivoting', () => {
        expect(intendedActiveUserId('user-b')).toBe('user-b');
    });

    it('is the account the oldest pass in flight started on while passes pivot, whatever IDB holds', async () => {
        const endOuter = passInFlight('user-a');
        const inner = whilePivoting('user-b', async () => intendedActiveUserId('user-c'));

        expect(await inner).toBe('user-a');
        await endOuter();
    });

    it("is the user's pick once they made one", async () => {
        const endPass = passInFlight('user-a');
        recordAccountChoice('user-c');

        expect(intendedActiveUserId('user-b')).toBe('user-c');
        await endPass();
    });

    it('goes back to the stored account once the pass ends, even when it fails', async () => {
        const failingPass = whilePivoting('user-a', async () => {
            throw new Error('pull failed');
        });
        await expect(failingPass).rejects.toThrow('pull failed');

        expect(intendedActiveUserId('user-b')).toBe('user-b');
    });
});
