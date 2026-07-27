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
 * Runs `task` while holding the named cross-context lock. Falls back to running unserialized when
 * the Web Locks API is unavailable (old browsers, node test env) — the per-context guards still
 * apply there, which is exactly the pre-lock behavior.
 *
 * NEVER call this re-entrantly for the same name from inside a held task: Web Locks are not
 * reentrant, so the inner request queues behind the outer hold forever.
 */
export async function withCrossContextLock<T>(name: string, task: () => Promise<T>): Promise<T> {
    if (typeof navigator === 'undefined' || !navigator.locks) {
        return task();
    }
    return navigator.locks.request(name, task);
}
