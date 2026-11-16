import type { IDBPDatabase } from 'idb';
import { use, useDeferredValue, useSyncExternalStore } from 'react';
import { type EntityRef, hasPendingChanges } from '../db/pendingChanges';
import { entityFreshness, type Freshness, isVerifiedWithNetwork, subscribeToSyncFreshness, syncFreshnessVersion } from '../lib/syncFreshness';
import type { MyDB } from '../types/MyDB';

/** The synced entity a page shows, and the account that owns it. */
export interface OwnedEntityRef extends EntityRef {
    userId: string;
}

// One queue read per (entity, freshness version): every reader of the same entity at the same
// version shares it, and use() never sees a new promise on a plain re-render.
const queueReads = new Map<string, { version: number; hasPending: Promise<boolean> }>();

function readHasPendingChanges(db: IDBPDatabase<MyDB>, entity: EntityRef, version: number): Promise<boolean> {
    // Keyed on the pair: a brief borrows its item's id.
    const key = `${entity.entityType}:${entity.entityId}`;
    const cached = queueReads.get(key);
    if (cached?.version === version) {
        return cached.hasPending;
    }
    // A failed read reports nothing pending rather than throwing into the page.
    const hasPending = hasPendingChanges(db, entity).catch(() => false);
    queueReads.set(key, { version, hasPending });
    return hasPending;
}

/**
 * Whether the entity on screen is known to match the server: `current`, `unverified` (no pull has
 * landed since the page loaded, the network came back or the app returned from a long background)
 * or `unsynced` (a local change still waits to be pushed). Suspends once on mount for the local
 * queue read.
 */
export function useEntityFreshness(db: IDBPDatabase<MyDB>, entity: OwnedEntityRef): Freshness {
    const version = useSyncExternalStore(subscribeToSyncFreshness, syncFreshnessVersion);
    // Deferred so a re-read renders in the background: the badge keeps its last answer instead of
    // dropping to the Suspense fallback on every queue change.
    const deferredVersion = useDeferredValue(version);
    const hasPendingLocalChanges = use(readHasPendingChanges(db, entity, deferredVersion));
    return entityFreshness({ isOwnerVerified: isVerifiedWithNetwork(entity.userId), hasPendingLocalChanges });
}

/** Test-only — versions restart per test, so a cached read would answer the next test's question. */
export function _resetEntityFreshnessCacheForTests(): void {
    queueReads.clear();
}
