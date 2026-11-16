import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    _resetSyncFreshnessForTests,
    forgetNetworkVerification,
    forgetNetworkVerificationFor,
    isAnyAccountVerified,
    isVerifiedWithNetwork,
    itemFreshness,
    markVerifiedWithNetwork,
    notifySyncQueueChanged,
    subscribeToSyncFreshness,
    syncFreshnessVersion,
} from '../lib/syncFreshness';

afterEach(() => {
    vi.unstubAllGlobals();
    _resetSyncFreshnessForTests();
});

describe('network verification', () => {
    it('treats every account as unverified until a pull from the server lands', () => {
        expect(isVerifiedWithNetwork('user-A')).toBe(false);
    });

    it('verifies only the account whose pull landed', () => {
        markVerifiedWithNetwork('user-A');

        expect(isVerifiedWithNetwork('user-A')).toBe(true);
        expect(isVerifiedWithNetwork('user-B')).toBe(false);
    });

    it('ignores a pull that lands after the browser went offline', () => {
        vi.stubGlobal('navigator', { onLine: false });

        markVerifiedWithNetwork('user-A');

        expect(isVerifiedWithNetwork('user-A')).toBe(false);
    });

    it("forgets one account's verification when its pull fails, keeping the others", () => {
        markVerifiedWithNetwork('user-A');
        markVerifiedWithNetwork('user-B');

        forgetNetworkVerificationFor('user-A');

        expect(isVerifiedWithNetwork('user-A')).toBe(false);
        expect(isVerifiedWithNetwork('user-B')).toBe(true);
    });

    it('forgets every verification when the network is lost', () => {
        markVerifiedWithNetwork('user-A');
        markVerifiedWithNetwork('user-B');

        forgetNetworkVerification();

        expect(isVerifiedWithNetwork('user-A')).toBe(false);
        expect(isVerifiedWithNetwork('user-B')).toBe(false);
    });
});

describe('isAnyAccountVerified — the status bar\'s "waiting for server"', () => {
    it('is false until some account has been checked with the server, and again after the network is lost', () => {
        expect(isAnyAccountVerified()).toBe(false);

        markVerifiedWithNetwork('user-A');
        expect(isAnyAccountVerified()).toBe(true);

        forgetNetworkVerification();
        expect(isAnyAccountVerified()).toBe(false);
    });
});

describe('change notifications', () => {
    it.each([
        ['a pull landing', () => markVerifiedWithNetwork('user-A')],
        ['the network being lost', () => forgetNetworkVerification()],
        ['a pull failing', () => forgetNetworkVerificationFor('user-A')],
        ['the sync queue changing', () => notifySyncQueueChanged()],
    ])('notifies subscribers and bumps the version on %s', (_event, change) => {
        const listener = vi.fn();
        subscribeToSyncFreshness(listener);
        const versionBefore = syncFreshnessVersion();

        change();

        expect(listener).toHaveBeenCalledTimes(1);
        expect(syncFreshnessVersion()).toBeGreaterThan(versionBefore);
    });

    it('stops notifying after unsubscribe', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeToSyncFreshness(listener);

        unsubscribe();
        notifySyncQueueChanged();

        expect(listener).not.toHaveBeenCalled();
    });
});

describe('itemFreshness', () => {
    it('is current when the owner is verified and nothing is queued', () => {
        expect(itemFreshness({ isOwnerVerified: true, hasPendingLocalChanges: false })).toBe('current');
    });

    it('is unverified when the owner has not been checked with the server', () => {
        expect(itemFreshness({ isOwnerVerified: false, hasPendingLocalChanges: false })).toBe('unverified');
    });

    it('reports unsynced local changes ahead of verification — they are what the server lacks', () => {
        expect(itemFreshness({ isOwnerVerified: true, hasPendingLocalChanges: true })).toBe('unsynced');
        expect(itemFreshness({ isOwnerVerified: false, hasPendingLocalChanges: true })).toBe('unsynced');
    });
});
