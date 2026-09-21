/**
 * The Weekly Review's once-per-run brief-sweep guard (`components/weeklyReview/reviewBriefSweep.ts`).
 * The guard is a plain module precisely so the "exactly one request" contract is testable without
 * rendering: the wizard effect adds nothing but the key and the ports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewSweepResult } from '../api/briefApi';
import { __resetReviewSweepGuardForTests, reviewSweepKey, runReviewBriefSweepOnce, sweepPinnedToOwner } from '../components/weeklyReview/reviewBriefSweep';

const STARTED: ReviewSweepResult = { outcome: 'started', started: 4, skippedWritten: 1 };

function makePorts(requestSweep: () => Promise<ReviewSweepResult> = () => Promise.resolve(STARTED), isOnline = true) {
    return {
        isOnline: vi.fn(() => isOnline),
        requestSweep: vi.fn(requestSweep),
        onError: vi.fn(),
        onOutcome: vi.fn(),
    };
}

beforeEach(() => {
    __resetReviewSweepGuardForTests();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('reviewSweepKey', () => {
    it('identifies a review run by account AND start stamp', () => {
        expect(reviewSweepKey('user-a', '2026-09-21T09:00:00.000Z')).toBe(reviewSweepKey('user-a', '2026-09-21T09:00:00.000Z'));
        expect(reviewSweepKey('user-a', '2026-09-21T09:00:00.000Z')).not.toBe(reviewSweepKey('user-b', '2026-09-21T09:00:00.000Z'));
        expect(reviewSweepKey('user-a', '2026-09-21T09:00:00.000Z')).not.toBe(reviewSweepKey('user-a', '2026-09-21T10:00:00.000Z'));
    });

    it('cannot be collided by a boundary shift between the two parts', () => {
        expect(reviewSweepKey('a', 'bc')).not.toBe(reviewSweepKey('ab', 'c'));
    });
});

describe('runReviewBriefSweepOnce', () => {
    it('sweeps on the first call for a key', async () => {
        const ports = makePorts();
        await runReviewBriefSweepOnce(reviewSweepKey('user-a', 'ts-1'), ports);
        expect(ports.requestSweep).toHaveBeenCalledTimes(1);
        expect(ports.onOutcome).toHaveBeenCalledWith('started');
        expect(ports.onError).not.toHaveBeenCalled();
    });

    it('fires once when the wizard mounts twice for the same review run (AppNav double-mount)', async () => {
        const key = reviewSweepKey('user-a', 'ts-1');
        const ports = makePorts();
        await runReviewBriefSweepOnce(key, ports);
        await runReviewBriefSweepOnce(key, ports);
        await runReviewBriefSweepOnce(key, ports);
        expect(ports.requestSweep).toHaveBeenCalledTimes(1);
    });

    it('fires once for a StrictMode double-effect: the second call claims the key before the first resolves', async () => {
        const key = reviewSweepKey('user-a', 'ts-1');
        let release: (() => void) | undefined;
        const ports = makePorts(
            () =>
                new Promise<ReviewSweepResult>((resolve) => {
                    release = () => resolve(STARTED);
                }),
        );
        // Both invoked synchronously in the same tick, as React's mount/unmount/remount does.
        const runs = Promise.all([runReviewBriefSweepOnce(key, ports), runReviewBriefSweepOnce(key, ports)]);
        expect(ports.requestSweep).toHaveBeenCalledTimes(1);
        release?.();
        await runs;
        expect(ports.requestSweep).toHaveBeenCalledTimes(1);
    });

    it('sweeps again for a genuinely new review run (a new startedTs)', async () => {
        const ports = makePorts();
        await runReviewBriefSweepOnce(reviewSweepKey('user-a', 'ts-1'), ports);
        await runReviewBriefSweepOnce(reviewSweepKey('user-a', 'ts-2'), ports);
        expect(ports.requestSweep).toHaveBeenCalledTimes(2);
    });

    it('sweeps per account: a second account reviewing in the same tab is not suppressed', async () => {
        const ports = makePorts();
        await runReviewBriefSweepOnce(reviewSweepKey('user-a', 'ts-1'), ports);
        await runReviewBriefSweepOnce(reviewSweepKey('user-b', 'ts-1'), ports);
        expect(ports.requestSweep).toHaveBeenCalledTimes(2);
    });

    it('hands an unexpected rejection to onError instead of rejecting into the effect', async () => {
        const boom = new Error('session pivot failed');
        const ports = makePorts(() => Promise.reject(boom));
        await expect(runReviewBriefSweepOnce(reviewSweepKey('user-a', 'ts-1'), ports)).resolves.toBeUndefined();
        expect(ports.onError).toHaveBeenCalledWith(boom);
        expect(ports.onOutcome).not.toHaveBeenCalled();
    });

    // Safe BECAUSE the offline pre-check (below) runs first: a rejection here is a real
    // server/network fault while the device believes it is online, not a never-attempted sweep.
    it('does not retry a failed sweep — the key stays claimed, the cron sweep is the backstop', async () => {
        const key = reviewSweepKey('user-a', 'ts-1');
        const ports = makePorts(() => Promise.reject(new Error('server fault')));
        await runReviewBriefSweepOnce(key, ports);
        await runReviewBriefSweepOnce(key, ports);
        expect(ports.requestSweep).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['cooldown', { outcome: 'cooldown' } as const],
        ['failed', { outcome: 'failed', status: 401 } as const],
    ])('reports the %s outcome without rejecting or calling onError', async (_label, result) => {
        const ports = makePorts(() => Promise.resolve(result));
        await expect(runReviewBriefSweepOnce(reviewSweepKey('user-a', 'ts-1'), ports)).resolves.toBeUndefined();
        expect(ports.onOutcome).toHaveBeenCalledWith(result.outcome);
        expect(ports.onError).not.toHaveBeenCalled();
    });

    it('skips entirely when offline — pinning the session is itself a network call', async () => {
        const ports = makePorts(undefined, false);
        await runReviewBriefSweepOnce(reviewSweepKey('user-a', 'ts-1'), ports);
        expect(ports.requestSweep).not.toHaveBeenCalled();
        expect(ports.onError).not.toHaveBeenCalled();
        expect(ports.onOutcome).not.toHaveBeenCalled();
    });

    it('leaves the key UNCLAIMED when offline, so the same review run still sweeps once online', async () => {
        const key = reviewSweepKey('user-a', 'ts-1');
        await runReviewBriefSweepOnce(key, makePorts(undefined, false));
        const online = makePorts();
        await runReviewBriefSweepOnce(key, online);
        expect(online.requestSweep).toHaveBeenCalledTimes(1);
    });
});

describe('sweepPinnedToOwner', () => {
    /**
     * Records the userIds the pivot was asked for; `vi.fn` cannot carry the generic signature.
     * `requestSweep` is injected in both cases so the pivot decision is exercised WITHOUT a live
     * fetch — under vitest's `node` environment `API_SERVER` is a reachable localhost URL, so an
     * un-injected call would silently hit the dev API server.
     */
    function makeSessionPivot() {
        const pivotedFor: string[] = [];
        const withOwnerSession = <T>(userId: string, task: () => Promise<T>): Promise<T> => {
            pivotedFor.push(userId);
            return task();
        };
        return { pivotedFor, withOwnerSession, requestSweep: vi.fn(() => Promise.resolve(STARTED)) };
    }

    it('skips the session pivot on a single-account device, but still issues the request', async () => {
        const { pivotedFor, withOwnerSession, requestSweep } = makeSessionPivot();
        const result = await sweepPinnedToOwner({ accountId: 'user-a', isMultiAccountDevice: false, withOwnerSession, requestSweep });
        expect(pivotedFor).toEqual([]);
        expect(requestSweep).toHaveBeenCalledTimes(1);
        expect(result).toEqual(STARTED);
    });

    it('pivots to the reviewing account when another account is logged in on this device', async () => {
        const { pivotedFor, withOwnerSession, requestSweep } = makeSessionPivot();
        const result = await sweepPinnedToOwner({ accountId: 'user-a', isMultiAccountDevice: true, withOwnerSession, requestSweep });
        expect(pivotedFor).toEqual(['user-a']);
        expect(requestSweep).toHaveBeenCalledTimes(1);
        expect(result).toEqual(STARTED);
    });
});
