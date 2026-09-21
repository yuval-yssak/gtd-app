import { KeyedMutex } from '../keyedMutex.js';
import {
    BRIEF_BATCH_DEFAULT_LIMIT,
    type HarvestBriefBatchesSummary,
    harvestBriefBatches,
    type SubmitBriefBatchSummary,
    submitBriefBatch,
} from './briefBatch.js';

/**
 * One scheduler tick: harvest what has ended, then submit the next batch. Harvest goes FIRST so a
 * batch that just ended frees the in-flight slot for this very tick instead of the next one.
 * Serialized on a single key: two overlapping cron hits (a slow harvest, a manual `jobs run`)
 * queue up rather than interleave, and the second one is cheap — the in-flight guard turns its
 * submit into a no-op when the first one just sent a batch.
 */
export interface BriefSweepSummary {
    harvest: HarvestBriefBatchesSummary;
    submit: SubmitBriefBatchSummary;
}

const SWEEP_KEY = 'brief-sweep';
const sweepMutex = new KeyedMutex();

export function runBriefSweep({ limit = BRIEF_BATCH_DEFAULT_LIMIT }: { limit?: number } = {}): Promise<BriefSweepSummary> {
    return sweepMutex.withLock(SWEEP_KEY, async () => {
        const harvest = await harvestBriefBatches();
        const submit = await submitBriefBatch({ limit });
        return { harvest, submit };
    });
}
