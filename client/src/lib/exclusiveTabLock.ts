/** Who owns an exclusive tab lock, as this tab sees it. */
export type TabLockOwnership = 'held' | 'heldElsewhere';

/** One tab asking to own a screen: the lock name, whether to take it from the current owner, and how to report back. */
export interface ExclusiveTabLockRequest {
    name: string;
    /** Take the lock from whichever tab holds it ("Continue here") instead of asking politely. */
    steal: boolean;
    /** Abort = this tab gives up: releases a held lock and withdraws a queued request. */
    signal: AbortSignal;
    onOwnershipChange: (ownership: TabLockOwnership) => void;
}

const isStolen = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';

/**
 * The ownership protocol on top of the Web Locks API. Ask without waiting (`ifAvailable`, or
 * `steal`); if another tab owns it, report `heldElsewhere` and queue behind it so the lock lands
 * here once that tab closes. A hold that is stolen re-queues. Any other failure (opaque origin,
 * inactive document) reports `held` — running unlocked, the behaviour before the lock existed —
 * rather than retrying a request that will only fail again.
 */
export function acquireExclusiveTabLock({ name, steal, signal, onOwnershipChange }: ExclusiveTabLockRequest) {
    const released = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    // Mutually recursive (a stolen hold re-queues), hence hoisted declarations.
    function hold() {
        if (signal.aborted) {
            return undefined; // granted after this tab gave up — release at once
        }
        onOwnershipChange('held');
        return released;
    }
    function queueBehindOwner() {
        onOwnershipChange('heldElsewhere');
        navigator.locks.request(name, { signal }, hold).catch(onRequestEnded);
    }
    function onRequestEnded(err: unknown) {
        if (signal.aborted) {
            return; // our own teardown
        }
        if (isStolen(err)) {
            queueBehindOwner();
            return;
        }
        console.warn('[tabLock] lock request failed — running unlocked', { name, err });
        onOwnershipChange('held');
    }
    // `steal` / `ifAvailable` cannot carry a signal (spec: NotSupportedError) — `hold` checks the abort instead.
    const firstAsk = steal ? { steal: true } : { ifAvailable: true };
    navigator.locks.request(name, firstAsk, (granted) => (granted ? hold() : signal.aborted ? undefined : queueBehindOwner())).catch(onRequestEnded);
}
