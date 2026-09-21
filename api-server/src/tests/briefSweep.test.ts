/** One scheduler tick (lib/brief/briefSweep.ts): harvest-then-submit order and the single-key
 * serialization that keeps two overlapping ticks from interleaving. The pipeline is mocked. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runBriefSweep } from '../lib/brief/briefSweep.js';

const harvestBriefBatches = vi.fn();
const submitBriefBatch = vi.fn();
vi.mock('../lib/brief/briefBatch.js', () => ({
    BRIEF_BATCH_DEFAULT_LIMIT: 2000,
    harvestBriefBatches: (...args: unknown[]) => harvestBriefBatches(...args),
    submitBriefBatch: (...args: unknown[]) => submitBriefBatch(...args),
}));

const HARVEST = { harvested: 1, pending: 0, expired: 0, failed: 0, errors: 0, resultCounts: {} };
const SUBMIT = { submitted: 3, skipped: 2, inFlight: false };

/** Records the call sequence; each step yields to the event loop so overlapping runs would interleave. */
function sequenced(log: string[]) {
    harvestBriefBatches.mockImplementation(async () => {
        log.push('harvest:start');
        await new Promise((resolve) => setImmediate(resolve));
        log.push('harvest:end');
        return HARVEST;
    });
    submitBriefBatch.mockImplementation(async () => {
        log.push('submit:start');
        await new Promise((resolve) => setImmediate(resolve));
        log.push('submit:end');
        return SUBMIT;
    });
}

beforeEach(() => {
    harvestBriefBatches.mockReset().mockResolvedValue(HARVEST);
    submitBriefBatch.mockReset().mockResolvedValue(SUBMIT);
});

describe('runBriefSweep', () => {
    it('harvests before it submits and returns both summaries', async () => {
        const log: string[] = [];
        sequenced(log);
        await expect(runBriefSweep({ limit: 25 })).resolves.toEqual({ harvest: HARVEST, submit: SUBMIT });
        expect(log).toEqual(['harvest:start', 'harvest:end', 'submit:start', 'submit:end']);
        expect(submitBriefBatch).toHaveBeenCalledWith({ limit: 25 });
    });

    it('defaults the limit to the batch default', async () => {
        await runBriefSweep();
        expect(submitBriefBatch).toHaveBeenCalledWith({ limit: 2000 });
    });

    it('serializes overlapping ticks: the second waits for the first and then runs in full, never interleaved', async () => {
        const log: string[] = [];
        sequenced(log);
        const [first, second] = await Promise.all([runBriefSweep(), runBriefSweep()]);
        expect(first).toEqual({ harvest: HARVEST, submit: SUBMIT });
        expect(second).toEqual({ harvest: HARVEST, submit: SUBMIT });
        expect(log).toEqual(['harvest:start', 'harvest:end', 'submit:start', 'submit:end', 'harvest:start', 'harvest:end', 'submit:start', 'submit:end']);
    });

    it('a failing tick does not poison the next one', async () => {
        harvestBriefBatches.mockRejectedValueOnce(new Error('atlas down'));
        await expect(runBriefSweep()).rejects.toThrow('atlas down');
        await expect(runBriefSweep()).resolves.toEqual({ harvest: HARVEST, submit: SUBMIT });
    });
});
