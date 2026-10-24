/**
 * Wraps an async task so overlapping requests collapse: one run at a time, and every request made
 * while a run is in flight is answered by exactly ONE follow-up run (a request that arrives
 * mid-run may have missed what that run already read, so it cannot simply be dropped). Every
 * caller gets the promise of the run that covers its request. A rejected run ends the cycle; the
 * next request starts afresh.
 */
export function coalesceAsync(task: () => Promise<void>): () => Promise<void> {
    // Closure state shared by every request; mutated only here.
    const state: { inFlight: Promise<void> | null; isFollowUpRequested: boolean } = { inFlight: null, isFollowUpRequested: false };

    const runUntilNoFollowUp = async () => {
        try {
            do {
                state.isFollowUpRequested = false;
                await task();
            } while (state.isFollowUpRequested);
        } finally {
            // Cleared in the same tick the loop decides it is done: clearing it in a later `.finally`
            // callback would leave a gap where a request sets the flag and no loop is left to read it.
            state.inFlight = null;
        }
    };

    return () => {
        if (state.inFlight) {
            state.isFollowUpRequested = true;
            return state.inFlight;
        }
        state.inFlight = runUntilNoFollowUp();
        return state.inFlight;
    };
}
