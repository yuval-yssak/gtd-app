import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    enterCase2Recovery,
    getSyncRecoveryState,
    resetSyncRecoveryStoreForTests,
    SYNC_RECOVERY_IDLE,
    setSyncRecoveryState,
    subscribeSyncRecovery,
} from '../contexts/syncRecoveryStore';

afterEach(() => {
    resetSyncRecoveryStoreForTests();
});

describe('syncRecoveryStore', () => {
    it('starts idle and returns a referentially stable snapshot between writes', () => {
        expect(getSyncRecoveryState()).toEqual({ phase: 'idle' });
        // useSyncExternalStore contract: repeated getSnapshot calls without a write return the
        // same reference, otherwise React loops re-rendering.
        expect(getSyncRecoveryState()).toBe(getSyncRecoveryState());
    });

    it('setSyncRecoveryState swaps the snapshot and notifies every subscriber', () => {
        const listenerA = vi.fn();
        const listenerB = vi.fn();
        subscribeSyncRecovery(listenerA);
        subscribeSyncRecovery(listenerB);

        setSyncRecoveryState({ phase: 'case1Syncing', userId: 'user-a' });

        expect(getSyncRecoveryState()).toEqual({ phase: 'case1Syncing', userId: 'user-a' });
        expect(listenerA).toHaveBeenCalledTimes(1);
        expect(listenerB).toHaveBeenCalledTimes(1);
    });

    it('unsubscribe stops notifications', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeSyncRecovery(listener);
        unsubscribe();

        setSyncRecoveryState({ phase: 'bootstrapping', userId: 'user-a' });

        expect(listener).not.toHaveBeenCalled();
    });

    it('supports the full Case-2 lifecycle: choice → flushing → flushFailed → bootstrapping → idle', () => {
        const observedPhases: string[] = [];
        subscribeSyncRecovery(() => observedPhases.push(getSyncRecoveryState().phase));

        enterCase2Recovery('user-a', 3);
        setSyncRecoveryState({ phase: 'flushing', userId: 'user-a', queuedOpCount: 3 });
        setSyncRecoveryState({
            phase: 'flushFailed',
            userId: 'user-a',
            queuedOpCount: 3,
            errorMessage: 'POST /sync/push 400',
            failedOpSummaries: ['create item: "Buy milk"'],
        });
        setSyncRecoveryState({ phase: 'bootstrapping', userId: 'user-a' });
        setSyncRecoveryState(SYNC_RECOVERY_IDLE);

        expect(observedPhases).toEqual(['case2Choice', 'flushing', 'flushFailed', 'bootstrapping', 'idle']);
    });

    it('enterCase2Recovery only transitions from idle — an active recovery is never clobbered', () => {
        enterCase2Recovery('user-a', 2);
        // A second reaped account detected mid-recovery must not replace the on-screen dialog.
        enterCase2Recovery('user-b', 5);

        expect(getSyncRecoveryState()).toEqual({ phase: 'case2Choice', userId: 'user-a', queuedOpCount: 2 });
    });
});
