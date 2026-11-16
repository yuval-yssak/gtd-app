/**
 * Whether what the device shows has been checked with the server. The UI renders from IndexedDB
 * whatever the network does, so it needs a separate signal to say a copy may be out of date.
 *
 * An account counts as verified once a pull (or bootstrap) from the server has been applied in this
 * page session, and stops counting when the browser goes offline. On a hanging network ("lie-fi")
 * no pull ever lands, so the account simply stays unverified while every screen still renders.
 *
 * Per-context module state: a Service Worker pull marks nothing here, but it messages the tab,
 * whose own sync then marks the account.
 */

import { isBrowserOffline } from './onlineStatus';

export type ItemFreshness = 'current' | 'unverified' | 'unsynced';

type Listener = () => void;

// External store state, mutated only through the functions below.
const verifiedUserIds = new Set<string>();
const listeners = new Set<Listener>();
const changes = { version: 0 };

function announceChange(): void {
    changes.version += 1;
    for (const listener of listeners) {
        listener();
    }
}

/**
 * Records that `userId`'s data has just been checked with the server. Announces every time, not only
 * on the first mark: a pull also follows pushes made by the Service Worker, which emptied the queue
 * without telling this context.
 */
export function markVerifiedWithNetwork(userId: string): void {
    // A response that landed just as the connection dropped proves nothing about what comes next;
    // the `offline` handler has already forgotten, and this must not undo it.
    if (isBrowserOffline()) {
        return;
    }
    verifiedUserIds.add(userId);
    announceChange();
}

/** The connection is gone: nothing on screen is known to match the server any more. */
export function forgetNetworkVerification(): void {
    verifiedUserIds.clear();
    announceChange();
}

/** A pull for `userId` failed: the device may have missed changes, so its copy is unverified again. */
export function forgetNetworkVerificationFor(userId: string): void {
    verifiedUserIds.delete(userId);
    announceChange();
}

export function isVerifiedWithNetwork(userId: string): boolean {
    return verifiedUserIds.has(userId);
}

/** Device-wide: has anything been checked with the server since the page loaded or reconnected? */
export function isAnyAccountVerified(): boolean {
    return verifiedUserIds.size > 0;
}

/** A change was queued for the server, or a push drained some — open items re-check their queue. */
export function notifySyncQueueChanged(): void {
    announceChange();
}

export function subscribeToSyncFreshness(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Snapshot for `useSyncExternalStore`: changes whenever any freshness input does. */
export function syncFreshnessVersion(): number {
    return changes.version;
}

/**
 * Unsynced outranks unverified: a local change the server has not received is the more specific
 * (and more important) thing to tell the user, whether or not the rest was checked.
 */
export function itemFreshness({ isOwnerVerified, hasPendingLocalChanges }: { isOwnerVerified: boolean; hasPendingLocalChanges: boolean }): ItemFreshness {
    if (hasPendingLocalChanges) return 'unsynced';
    return isOwnerVerified ? 'current' : 'unverified';
}

export function _resetSyncFreshnessForTests(): void {
    verifiedUserIds.clear();
    listeners.clear();
    changes.version = 0;
}
