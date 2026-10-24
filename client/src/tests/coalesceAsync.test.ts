import { describe, expect, it, vi } from 'vitest';
import { coalesceAsync } from '../lib/coalesceAsync';

/** A task whose runs the test settles by hand, so overlapping calls can be staged deterministically. */
function controllableTask() {
    const releases: Array<() => void> = [];
    const task = vi.fn(
        () =>
            new Promise<void>((resolve) => {
                releases.push(resolve);
            }),
    );
    const releaseNext = async () => {
        const release = releases.shift();
        if (!release) throw new Error('no run in flight');
        release();
        // Let the wrapper's continuation (the follow-up check) run.
        await Promise.resolve();
        await Promise.resolve();
    };
    return { task, releaseNext };
}

describe('coalesceAsync', () => {
    it('runs the task once for a single call', async () => {
        const { task, releaseNext } = controllableTask();
        const request = coalesceAsync(task);

        const done = request();
        await releaseNext();
        await done;

        expect(task).toHaveBeenCalledTimes(1);
    });

    it('collapses any number of calls made during a run into exactly one follow-up run', async () => {
        const { task, releaseNext } = controllableTask();
        const request = coalesceAsync(task);

        const done = request();
        void request();
        void request();
        void request();
        expect(task).toHaveBeenCalledTimes(1);

        await releaseNext();
        expect(task).toHaveBeenCalledTimes(2);
        await releaseNext();
        await done;

        expect(task).toHaveBeenCalledTimes(2);
    });

    it('starts a fresh run for a call made after the previous one settled', async () => {
        const { task, releaseNext } = controllableTask();
        const request = coalesceAsync(task);

        const first = request();
        await releaseNext();
        await first;
        const second = request();
        await releaseNext();
        await second;

        expect(task).toHaveBeenCalledTimes(2);
    });

    it('a request made as the previous run settles still gets its own run', async () => {
        const firstRun = Promise.resolve();
        const task = vi.fn().mockReturnValueOnce(firstRun).mockResolvedValue(undefined);
        const request = coalesceAsync(task);

        const first = request();
        // Chained on the task's own promise (as another sync path awaiting the same work would be):
        // fires right after the run's loop has decided it is done, before its cleanup.
        const second = firstRun.then(() => request());
        await first;
        await second;
        await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(2));
    });

    it('accepts new calls after a run rejects', async () => {
        const task = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
        const request = coalesceAsync(task);

        await expect(request()).rejects.toThrow('offline');
        await request();

        expect(task).toHaveBeenCalledTimes(2);
    });
});
