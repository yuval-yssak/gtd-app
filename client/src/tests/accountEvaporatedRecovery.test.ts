import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_EVAPORATED_STORAGE_KEY, parseEvaporationBroadcast, subscribeToEvaporationBroadcast } from '../contexts/accountEvaporatedEvents';
import {
    type EvaporationRefreshDeps,
    refreshAfterAccountEvaporation,
    reloadDestination,
    reloadIfTabAccountGone,
    shouldReloadForMissingAccount,
    shouldReloadOnEvaporation,
} from '../contexts/accountEvaporatedRecovery';

describe('shouldReloadOnEvaporation', () => {
    it("reloads when the evaporated account is the one this tab booted with — another tab moved the pointer, this tab can't follow", () => {
        expect(shouldReloadOnEvaporation('user-a', 'user-a')).toBe(true);
    });

    it('does not reload for a different (non-active) account', () => {
        expect(shouldReloadOnEvaporation('user-b', 'user-a')).toBe(false);
    });

    it('does not reload when the tab has no account at all (login page, boot before hydration)', () => {
        expect(shouldReloadOnEvaporation('user-a', null)).toBe(false);
    });
});

describe('shouldReloadForMissingAccount', () => {
    it('reloads when the boot-time account is no longer in the IDB account list (another tab removed it)', () => {
        expect(shouldReloadForMissingAccount('user-a', ['user-b', 'user-c'])).toBe(true);
        expect(shouldReloadForMissingAccount('user-a', [])).toBe(true);
    });

    it('does nothing while the account is still listed, or when the tab has no account', () => {
        expect(shouldReloadForMissingAccount('user-a', ['user-a', 'user-b'])).toBe(false);
        expect(shouldReloadForMissingAccount(null, [])).toBe(false);
    });
});

describe('reloadDestination', () => {
    it('goes to / (which routes onto the active account) while someone remains, and to /login when nobody does', () => {
        expect(reloadDestination(['user-b'])).toBe('/');
        expect(reloadDestination([])).toBe('/login');
    });
});

describe('reloadIfTabAccountGone', () => {
    function deps(tabAccountId: string | null, remaining: string[], onlyWhenNoneRemain?: boolean) {
        const navigate = vi.fn();
        return {
            navigate,
            args: { tabAccountId, readLoggedInUserIds: async () => remaining, navigate, ...(onlyWhenNoneRemain ? { onlyWhenNoneRemain } : {}) },
        };
    }

    it('stays when the tab account is still signed in', async () => {
        const { navigate, args } = deps('user-a', ['user-a', 'user-b']);
        expect(await reloadIfTabAccountGone(args)).toBeNull();
        expect(navigate).not.toHaveBeenCalled();
    });

    it('reloads to / when the tab account is gone but a survivor remains', async () => {
        const { navigate, args } = deps('user-a', ['user-b']);
        expect(await reloadIfTabAccountGone(args)).toBe('/');
        expect(navigate).toHaveBeenCalledExactlyOnceWith('/');
    });

    it('reloads to /login when the tab account is gone and nobody remains', async () => {
        const { navigate, args } = deps('user-a', []);
        expect(await reloadIfTabAccountGone(args)).toBe('/login');
        expect(navigate).toHaveBeenCalledExactlyOnceWith('/login');
    });

    it('onlyWhenNoneRemain: a missing account with survivors is another tab mid-evaporation — stay and let its broadcast route us', async () => {
        const { navigate, args } = deps('user-a', ['user-b'], true);
        expect(await reloadIfTabAccountGone(args)).toBeNull();
        expect(navigate).not.toHaveBeenCalled();

        const empty = deps('user-a', [], true);
        expect(await reloadIfTabAccountGone(empty.args)).toBe('/login');
    });

    it('does nothing for a tab without an account', async () => {
        const { navigate, args } = deps(null, []);
        expect(await reloadIfTabAccountGone(args)).toBeNull();
        expect(navigate).not.toHaveBeenCalled();
    });
});

describe('parseEvaporationBroadcast (cross-tab receive path)', () => {
    it('returns the userId from a well-formed payload under the evaporation key', () => {
        expect(parseEvaporationBroadcast(ACCOUNT_EVAPORATED_STORAGE_KEY, JSON.stringify({ userId: 'user-a', ts: 1 }))).toBe('user-a');
    });

    it('ignores other keys, removals and malformed payloads', () => {
        expect(parseEvaporationBroadcast('gtd:accountReauthResolved', JSON.stringify({ userId: 'user-a' }))).toBeNull();
        expect(parseEvaporationBroadcast(ACCOUNT_EVAPORATED_STORAGE_KEY, null)).toBeNull();
        expect(parseEvaporationBroadcast(ACCOUNT_EVAPORATED_STORAGE_KEY, 'not json')).toBeNull();
        expect(parseEvaporationBroadcast(ACCOUNT_EVAPORATED_STORAGE_KEY, JSON.stringify({ ts: 1 }))).toBeNull();
        expect(parseEvaporationBroadcast(ACCOUNT_EVAPORATED_STORAGE_KEY, JSON.stringify({ userId: '' }))).toBeNull();
        expect(parseEvaporationBroadcast(null, null)).toBeNull();
    });
});

describe('subscribeToEvaporationBroadcast', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('listens for storage events, forwards only evaporation payloads, and unsubscribes the very same listener', () => {
        const addEventListener = vi.fn();
        const removeEventListener = vi.fn();
        vi.stubGlobal('window', { addEventListener, removeEventListener });
        const onEvaporated = vi.fn();

        const unsubscribe = subscribeToEvaporationBroadcast(onEvaporated);

        expect(addEventListener).toHaveBeenCalledTimes(1);
        const [registration] = addEventListener.mock.calls;
        if (!registration) throw new Error('expected one addEventListener call');
        const [eventName, listener] = registration as [string, (event: { key: string | null; newValue: string | null }) => void];
        expect(eventName).toBe('storage');

        listener({ key: 'gtd:accountReauthResolved', newValue: JSON.stringify({ userId: 'user-x' }) });
        listener({ key: ACCOUNT_EVAPORATED_STORAGE_KEY, newValue: JSON.stringify({ userId: 'user-a', ts: 1 }) });
        expect(onEvaporated).toHaveBeenCalledExactlyOnceWith('user-a');

        unsubscribe();
        expect(removeEventListener).toHaveBeenCalledExactlyOnceWith('storage', listener);
    });
});

describe('refreshAfterAccountEvaporation', () => {
    function makeDeps(overrides: Partial<EvaporationRefreshDeps> = {}) {
        const order: string[] = [];
        const deps: EvaporationRefreshDeps = {
            refreshAccounts: vi.fn(async () => {
                order.push('refreshAccounts');
            }),
            getDeviceId: vi.fn(async () => {
                order.push('getDeviceId');
                return 'dev-1';
            }),
            isStillMounted: () => true,
            isOnline: () => true,
            reopenSse: vi.fn((deviceId: string) => {
                order.push(`reopenSse:${deviceId}`);
            }),
            refreshResources: vi.fn(() => {
                order.push('refreshResources');
            }),
            ...overrides,
        };
        return { deps, order };
    }

    it('online + mounted: refreshes accounts first, then reopens SSE with the device id and refreshes resources', async () => {
        const { deps, order } = makeDeps();

        expect(await refreshAfterAccountEvaporation(deps)).toBe('reopened');

        // Accounts must be re-read BEFORE SSE reopens — openSseConnections reads the surviving ids.
        expect(order).toEqual(['refreshAccounts', 'getDeviceId', 'reopenSse:dev-1', 'refreshResources']);
    });

    it('offline: skips the SSE reopen (the online effect does it later) but still refreshes resources', async () => {
        const { deps } = makeDeps({ isOnline: () => false });

        expect(await refreshAfterAccountEvaporation(deps)).toBe('offline');

        expect(deps.reopenSse).not.toHaveBeenCalled();
        expect(deps.refreshResources).toHaveBeenCalledOnce();
    });

    it('unmounted while the reads were in flight: neither reopens SSE (would leak a channel) nor touches resources', async () => {
        const { deps } = makeDeps({ isStillMounted: () => false });

        expect(await refreshAfterAccountEvaporation(deps)).toBe('unmounted');

        expect(deps.refreshAccounts).toHaveBeenCalledOnce();
        expect(deps.reopenSse).not.toHaveBeenCalled();
        expect(deps.refreshResources).not.toHaveBeenCalled();
    });
});
