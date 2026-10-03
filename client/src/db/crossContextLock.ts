/**
 * Cross-context mutual exclusion via the Web Locks API.
 *
 * Module-level guards (`pullInFlight`, `sessionGate`, `flushInFlight`) only serialize within ONE
 * JS context — every tab and the Service Worker each get their own module instances, so two
 * contexts can interleave sync work against the shared IndexedDB. `navigator.locks` is the only
 * primitive that serializes across all contexts on the origin (tabs AND the Service Worker), and
 * a held lock is released automatically when its callback settles or its context dies — no TTL
 * bookkeeping, no stale-lock recovery.
 */

/** Guards server-op application to IndexedDB (pull + bootstrap) across tabs and the Service Worker. */
export const SYNC_APPLY_LOCK = 'gtd-sync-apply';

/**
 * Guards the push of queued ops (`flushSyncQueue`) across tabs and the Service Worker. A waiter
 * QUEUES behind the holder rather than skipping: the holder's loop drains ops queued meanwhile, and
 * whatever is left is pushed by the waiter the moment the lock frees. Skipping was the old
 * IDB-marker behaviour and stranded a row-level "Mark done" for ~100s behind a Service Worker
 * flush whose request had hung (nothing re-triggered the push until the next navigation).
 */
export const SYNC_FLUSH_LOCK = 'gtd-sync-flush';

/** True when this context can serialize through the Web Locks API (all evergreen browsers; absent in node tests). */
export function hasWebLocks(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.locks;
}

export interface CrossContextLockOptions {
    /**
     * Bounds the WAIT for the lock: an abort before the grant rejects the request with `signal.reason`
     * (so callers tell "gave up waiting" from a task failure by identity). A grant already made is unaffected.
     */
    signal?: AbortSignal;
}

/**
 * Runs `task` while holding the named cross-context lock. Falls back to running unserialized when
 * the Web Locks API is unavailable (old browsers, node test env) — the per-context guards still
 * apply there, which is exactly the pre-lock behavior.
 *
 * NEVER call this re-entrantly for the same name from inside a held task: Web Locks are not
 * reentrant, so the inner request queues behind the outer hold forever.
 */
export async function withCrossContextLock<T>(name: string, task: () => Promise<T>, options: CrossContextLockOptions = {}): Promise<T> {
    if (!hasWebLocks()) {
        return task();
    }
    // Two call forms rather than `{ signal: undefined }`: `exactOptionalPropertyTypes` rejects the
    // undefined member, and the two-argument form is what existing lock fakes in tests understand.
    return options.signal ? navigator.locks.request(name, { signal: options.signal }, task) : navigator.locks.request(name, task);
}
