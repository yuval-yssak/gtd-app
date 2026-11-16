import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRepairRetrier, REPAIR_RETRY_DELAYS_MS } from '../lib/repairRetrier';

const [FIRST_DELAY_MS = 0, SECOND_DELAY_MS = 0] = REPAIR_RETRY_DELAYS_MS;
const LONGEST_DELAY_MS = REPAIR_RETRY_DELAYS_MS[REPAIR_RETRY_DELAYS_MS.length - 1] ?? 0;

/** A retrier over a hand-flipped "repaired" flag, counting the repair passes it starts. */
function retrierWithFlag() {
    const health = { isRepaired: false };
    const repair = vi.fn();
    const retrier = createRepairRetrier({ repair, isRepaired: () => health.isRepaired });
    return { health, repair, retrier };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('createRepairRetrier', () => {
    it('does nothing while the connection needs no repair', async () => {
        const { health, repair, retrier } = retrierWithFlag();
        health.isRepaired = true;

        retrier.ensureRunning();
        await vi.advanceTimersByTimeAsync(LONGEST_DELAY_MS * 3);

        expect(repair).not.toHaveBeenCalled();
    });

    it('retries with a growing delay while the connection stays broken', async () => {
        const { repair, retrier } = retrierWithFlag();

        retrier.ensureRunning();
        await vi.advanceTimersByTimeAsync(FIRST_DELAY_MS - 1);
        expect(repair).toHaveBeenCalledTimes(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(repair).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(SECOND_DELAY_MS - 1);
        expect(repair).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(repair).toHaveBeenCalledTimes(2);
    });

    it('keeps retrying at the longest delay for as long as the connection stays broken', async () => {
        const { repair, retrier } = retrierWithFlag();
        const totalBackoffMs = REPAIR_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);

        retrier.ensureRunning();
        await vi.advanceTimersByTimeAsync(totalBackoffMs + LONGEST_DELAY_MS * 2);

        expect(repair).toHaveBeenCalledTimes(REPAIR_RETRY_DELAYS_MS.length + 2);
    });

    it('stops once a repair succeeded, and starts over from the shortest delay next time', async () => {
        const { health, repair, retrier } = retrierWithFlag();
        retrier.ensureRunning();
        await vi.advanceTimersByTimeAsync(FIRST_DELAY_MS + SECOND_DELAY_MS);
        expect(repair).toHaveBeenCalledTimes(2);

        health.isRepaired = true;
        await vi.advanceTimersByTimeAsync(LONGEST_DELAY_MS * 3);
        expect(repair).toHaveBeenCalledTimes(2);

        health.isRepaired = false;
        retrier.ensureRunning();
        await vi.advanceTimersByTimeAsync(FIRST_DELAY_MS);
        expect(repair).toHaveBeenCalledTimes(3);
    });

    it('runs one retry chain however often it is asked to', async () => {
        const { repair, retrier } = retrierWithFlag();

        retrier.ensureRunning();
        retrier.ensureRunning();
        retrier.ensureRunning();
        await vi.advanceTimersByTimeAsync(FIRST_DELAY_MS);

        expect(repair).toHaveBeenCalledTimes(1);
    });

    it('makes no further repair after stop', async () => {
        const { repair, retrier } = retrierWithFlag();

        retrier.ensureRunning();
        retrier.stop();
        await vi.advanceTimersByTimeAsync(LONGEST_DELAY_MS * 3);

        expect(repair).not.toHaveBeenCalled();
    });
});
