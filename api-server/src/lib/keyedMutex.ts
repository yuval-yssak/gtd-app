/**
 * Per-key FIFO promise-chain mutex. Serializes async tasks that share a key while letting tasks
 * with different keys run concurrently. The chain is a single in-process promise per key; callers
 * `await` it, so this is a fair FIFO mutex within one process (Cloud Run runs --max-instances=1,
 * so one process is the whole story — an existing codebase assumption).
 *
 * Lifted from the per-calendar sync serialization in routes/calendar.ts so other subsystems
 * (e.g. per-entity reassign locking) can reuse the same primitive.
 */
export class KeyedMutex {
    private readonly chains = new Map<string, Promise<unknown>>();

    /** Runs `task` after any in-flight task for the same key completes, chaining so concurrent callers serialize. */
    async withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
        const prior = this.chains.get(key) ?? Promise.resolve();
        // Swallow the predecessor's rejection here so one failed task doesn't reject every queued
        // caller; each task's own result/rejection still propagates to its own awaiter below.
        const run = prior.then(
            () => task(),
            () => task(),
        );
        // Keep the chain pointer current; clear it once this run settles IF no later caller has extended it.
        this.chains.set(key, run);
        try {
            return await run;
        } finally {
            if (this.chains.get(key) === run) {
                this.chains.delete(key);
            }
        }
    }
}
