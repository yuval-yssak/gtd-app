import type { IDBPDatabase } from 'idb';
import { use, useDeferredValue, useSyncExternalStore } from 'react';
import { hasPendingChanges } from '../db/pendingChanges';
import { type ItemFreshness, isVerifiedWithNetwork, itemFreshness, subscribeToSyncFreshness, syncFreshnessVersion } from '../lib/syncFreshness';
import type { MyDB, StoredItem } from '../types/MyDB';

// One queue read per (item, freshness version): every reader of the same item at the same version
// shares it, and use() never sees a new promise on a plain re-render.
const queueReads = new Map<string, { version: number; hasPending: Promise<boolean> }>();

function readHasPendingChanges(db: IDBPDatabase<MyDB>, itemId: string, version: number): Promise<boolean> {
    const cached = queueReads.get(itemId);
    if (cached?.version === version) {
        return cached.hasPending;
    }
    // A failed read reports nothing pending rather than throwing into the page.
    const hasPending = hasPendingChanges(db, { entityType: 'item', entityId: itemId }).catch(() => false);
    queueReads.set(itemId, { version, hasPending });
    return hasPending;
}

/**
 * Whether the item on screen is known to match the server: `current`, `unverified` (no pull has
 * landed since the page loaded or the network came back) or `unsynced` (a local change still waits
 * to be pushed). Suspends once on mount for the local queue read.
 */
export function useItemFreshness(db: IDBPDatabase<MyDB>, item: StoredItem): ItemFreshness {
    const version = useSyncExternalStore(subscribeToSyncFreshness, syncFreshnessVersion);
    // Deferred so a re-read renders in the background: the badge keeps its last answer instead of
    // dropping to the Suspense fallback on every queue change.
    const deferredVersion = useDeferredValue(version);
    const hasPendingLocalChanges = use(readHasPendingChanges(db, item._id, deferredVersion));
    return itemFreshness({ isOwnerVerified: isVerifiedWithNetwork(item.userId), hasPendingLocalChanges });
}

/** Test-only — versions restart per test, so a cached read would answer the next test's question. */
export function _resetItemFreshnessCacheForTests(): void {
    queueReads.clear();
}
