import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { areAccountsCaughtUp, CATCH_UP_RETRY_DELAYS_MS, createCatchUpRetrier } from '../lib/catchUpRetry';

const [FIRST_DELAY_MS = 0, SECOND_DELAY_MS = 0] = CATCH_UP_RETRY_DELAYS_MS;
const LONGEST_DELAY_MS = CATCH_UP_RETRY_DELAYS_MS[CATCH_UP_RETRY_DELAYS_MS.length - 1] ?? 0;

/** A retrier over a hand-flipped "caught up" flag, counting the catch-up attempts it makes. */
function retrierWithFlag() {
    const sync = { isCaughtUp: false };
    const attempt = vi.fn();
    const retrier = createCatchUpRetrier({ attempt, isCaughtUp: () => sync.isCaughtUp });
    return { sync, attempt, retrier };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('createCatchUpRetrier', () => {
    it('does nothing while the device is caught up with the server', async () => {
        const { sync, attempt, retrier } = retrierWithFlag();
        sync.isCaughtUp = true;

        retrier.ensureRunning();
        await vi.advanceTimersByTimeAsync(LONGEST_DELAY_MS * 3);

        expect(attempt).not.toHaveBeenCalled();
    });

    it('retries with a growing delay while the device stays behind', async () => {
        const { attempt, retrier } = retrierWithFlag();

        retrier.ensureRunning();
        await vi.advanceTimersByTimeAsync(FIRST_DELAY_MS - 1);
        expect(attempt).toHaveBeenCalledTimes(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(attempt).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(SECOND_DELAY_MS - 1);
        expect(attempt).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(attempt).toHaveBeenCalledTimes(2);
    });

    it('keeps retrying at the longest delay for as long as the device stays behind', async () => {
        const { attempt, retrier } = retrierWithFlag();
        const totalBackoffMs = CATCH_UP_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);

        retrier.ensureRunning();
        await vi.advanceTimersByTimeAsync(totalBackoffMs + LONGEST_DELAY_MS * 2);

        expect(attempt).toHaveBeenCalledTimes(CATCH_UP_RETRY_DELAYS_MS.length + 2);
    });

    it('stops once a pull has caught the device up, and starts over from the shortest delay next time', async () => {
        const { sync, attempt, retrier } = retrierWithFlag();
        retrier.ensureRunning();
        await vi.advanceTimersByTimeAsync(FIRST_DELAY_MS + SECOND_DELAY_MS);
        expect(attempt).toHaveBeenCalledTimes(2);

        sync.isCaughtUp = true;
        await vi.advanceTimersByTimeAsync(LONGEST_DELAY_MS * 3);
        expect(attempt).toHaveBeenCalledTimes(2);

        sync.isCaughtUp = false;
        retrier.ensureRunning();
        await vi.advanceTimersByTimeAsync(FIRST_DELAY_MS);
        expect(attempt).toHaveBeenCalledTimes(3);
    });

    it('runs one retry chain however often it is asked to', async () => {
        const { attempt, retrier } = retrierWithFlag();

        retrier.ensureRunning();
        retrier.ensureRunning();
        retrier.ensureRunning();
        await vi.advanceTimersByTimeAsync(FIRST_DELAY_MS);

        expect(attempt).toHaveBeenCalledTimes(1);
    });

    it('makes no further attempt after stop', async () => {
        const { attempt, retrier } = retrierWithFlag();

        retrier.ensureRunning();
        retrier.stop();
        await vi.advanceTimersByTimeAsync(LONGEST_DELAY_MS * 3);

        expect(attempt).not.toHaveBeenCalled();
    });
});

describe('areAccountsCaughtUp', () => {
    const verified = new Set(['user-A']);
    const awaitingSignIn = new Set(['user-B']);
    const accountState = { isVerified: (id: string) => verified.has(id), needsReauth: (id: string) => awaitingSignIn.has(id) };

    it('is true once every account has been checked with the server', () => {
        expect(areAccountsCaughtUp(['user-A'], accountState)).toBe(true);
    });

    it('is false while some account has not been checked', () => {
        expect(areAccountsCaughtUp(['user-A', 'user-C'], accountState)).toBe(false);
    });

    // Its pull fails until the user signs in again; retrying it would loop forever, in every tab.
    it('ignores an account waiting for the user to sign in again', () => {
        expect(areAccountsCaughtUp(['user-A', 'user-B'], accountState)).toBe(true);
    });
});
