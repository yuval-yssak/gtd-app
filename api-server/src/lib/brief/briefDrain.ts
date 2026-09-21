import { KeyedMutex } from '../keyedMutex.js';

/**
 * ONE process-wide queue for every background brief generation (the write-path inline hook and
 * the review-start sweep): whatever fires, model calls run strictly one at a time, so neither
 * path can fan out into an Anthropic 429 storm and the two cannot double up on each other.
 * Correct under Cloud Run `--max-instances=1`: one process owns the queue. The on-demand endpoint
 * and the Message Batches sweep are deliberately NOT routed through it — a user's button press
 * must not wait behind a background backlog, and a batch is a single upstream call.
 */
const DRAIN_KEY = 'brief-generation-drain';
const drain = new KeyedMutex();

/** Runs `task` after every previously queued background generation has settled. */
export function withBriefGenerationDrain<T>(task: () => Promise<T>): Promise<T> {
    return drain.withLock(DRAIN_KEY, task);
}
