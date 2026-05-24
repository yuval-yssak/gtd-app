/**
 * Retry an async call up to 3 times with 1s / 5s / 24s backoff when `isTransient(err)` is true,
 * otherwise rethrow immediately. Used by the offline RSVP / gcalMeta replay path so a flaky GCal
 * tick doesn't immediately mark the op `syncFailed` — three attempts over ~30s is enough to ride
 * out a deploy / pubsub hiccup.
 *
 * Returns the final successful result or rethrows the last error after exhausting attempts.
 *
 * The function blocks via `setTimeout` between attempts. In tests use `vi.useFakeTimers()` plus
 * `vi.runAllTimersAsync()` so the suite runs without waiting on real wall-clock delays.
 */
export async function retryWithBackoff<T>(fn: () => Promise<T>, isTransient: (err: unknown) => boolean): Promise<T> {
    // 1s, 5s, 24s ≈ 30s total budget. Match exactly the plan's spec — adjusting here would
    // change the user-visible window between optimistic update and SyncIssuesPanel entry.
    const delays = [1000, 5000, 24000];
    let attempt = 0;
    while (true) {
        try {
            return await fn();
        } catch (err) {
            // Out of retries OR error is not retryable → propagate. The caller bucketizes via
            // categorizeGCalError to decide how the SyncIssuesPanel should remediate. `.at()` is
            // out-of-bounds-safe and removes the dead `delay === undefined` branch that confused
            // the type narrower (the `attempt >= delays.length` guard above already covers it).
            if (attempt >= delays.length || !isTransient(err)) {
                throw err;
            }
            const delay = delays.at(attempt) ?? 0;
            await new Promise((resolve) => setTimeout(resolve, delay));
            attempt++;
        }
    }
}
