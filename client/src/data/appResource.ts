import type { IDBPDatabase } from 'idb';
import { getItemsAcrossUsers } from '../db/itemHelpers';
import { getPeopleAcrossUsers } from '../db/personHelpers';
import { getReviewInboxesAcrossUsers } from '../db/reviewInboxHelpers';
import { getRoutinesAcrossUsers } from '../db/routineHelpers';
import { getWorkContextsAcrossUsers } from '../db/workContextHelpers';
import type { MyDB, StoredItem, StoredPerson, StoredReviewInbox, StoredRoutine, StoredWorkContext } from '../types/MyDB';

/**
 * Per-user-set bundle of promises that components `use()`. The fields are kept independent so
 * a scoped invalidation (e.g. only items changed) doesn't make every list page re-suspend.
 */
export interface AppResourceSnapshot {
    items: Promise<StoredItem[]>;
    routines: Promise<StoredRoutine[]>;
    people: Promise<StoredPerson[]>;
    workContexts: Promise<StoredWorkContext[]>;
    reviewInboxes: Promise<StoredReviewInbox[]>;
}

export type ResourceScope = 'items' | 'routines' | 'people' | 'workContexts' | 'reviewInboxes' | 'all';

interface CacheEntry {
    db: IDBPDatabase<MyDB>;
    userIds: readonly string[];
    snapshot: AppResourceSnapshot;
}

// Module-level cache. Keyed on a stable string of `<dbName>|<sortedUserIds>` so the same
// (db, users) pair always returns the same snapshot — that identity is what lets two
// components `use()` the same field without firing two IDB reads.
const cache = new Map<string, CacheEntry>();

/**
 * Cache key for a (db, userIds) pair. Exported so AppResourceProvider can distinguish "the
 * signed-in set changed" (key changes → adopt the new snapshot urgently) from "the cache was
 * invalidated" (key unchanged → the swap must stay inside refresh()'s startTransition).
 */
export function appResourceKey(db: IDBPDatabase<MyDB>, userIds: readonly string[]): string {
    const sorted = [...userIds].sort().join(',');
    return `${db.name}|${sorted}`;
}

/**
 * Whether AppResourceProvider may adopt a freshly derived snapshot during render (urgently,
 * outside startTransition). True only for a (db, userIds) context shift. A previous version
 * keyed this on snapshot identity, which is also true after a cache invalidation — any urgent
 * parent re-render then suspended the whole route to its fallback for the length of the IDB
 * re-read (the "page blink"). Pure and exported so that regression stays unit-testable.
 */
export function shouldAdoptSnapshotDuringRender(renderedKey: string, nextKey: string): boolean {
    return nextKey !== renderedKey;
}

function buildSnapshot(db: IDBPDatabase<MyDB>, userIds: readonly string[]): AppResourceSnapshot {
    const ids = [...userIds];
    return {
        items: getItemsAcrossUsers(db, ids),
        routines: getRoutinesAcrossUsers(db, ids),
        people: getPeopleAcrossUsers(db, ids),
        workContexts: getWorkContextsAcrossUsers(db, ids),
        reviewInboxes: getReviewInboxesAcrossUsers(db, ids),
    };
}

/**
 * Returns the stable snapshot of promises for this (db, userIds) pair. Repeat calls with the
 * same arguments return the *same* promise references — that's what enables Suspense to dedupe.
 */
export function getAppResource(db: IDBPDatabase<MyDB>, userIds: readonly string[]): AppResourceSnapshot {
    const key = appResourceKey(db, userIds);
    const existing = cache.get(key);
    if (existing) {
        return existing.snapshot;
    }
    const snapshot = buildSnapshot(db, userIds);
    cache.set(key, { db, userIds: [...userIds], snapshot });
    return snapshot;
}

/**
 * Invalidates the cache so the next `getAppResource(db, userIds)` builds a fresh snapshot. When
 * `scope` is `'all'` (or omitted) the whole entry is dropped. For a single field, only that
 * promise is replaced — the unchanged promises keep their identity so consumers that `use()`
 * them never re-suspend.
 */
export function invalidateAppResource(db: IDBPDatabase<MyDB>, userIds: readonly string[], scope: ResourceScope = 'all'): AppResourceSnapshot {
    const key = appResourceKey(db, userIds);
    const existing = cache.get(key);
    if (!existing || scope === 'all') {
        const snapshot = buildSnapshot(db, userIds);
        cache.set(key, { db, userIds: [...userIds], snapshot });
        return snapshot;
    }
    const next = replaceField(existing.snapshot, db, [...userIds], scope);
    cache.set(key, { db, userIds: [...userIds], snapshot: next });
    return next;
}

function replaceField(prev: AppResourceSnapshot, db: IDBPDatabase<MyDB>, userIds: string[], scope: Exclude<ResourceScope, 'all'>): AppResourceSnapshot {
    switch (scope) {
        case 'items':
            return { ...prev, items: getItemsAcrossUsers(db, userIds) };
        case 'routines':
            return { ...prev, routines: getRoutinesAcrossUsers(db, userIds) };
        case 'people':
            return { ...prev, people: getPeopleAcrossUsers(db, userIds) };
        case 'workContexts':
            return { ...prev, workContexts: getWorkContextsAcrossUsers(db, userIds) };
        case 'reviewInboxes':
            return { ...prev, reviewInboxes: getReviewInboxesAcrossUsers(db, userIds) };
    }
}

/** Test-only: drops the entire module cache. Real code should use scoped invalidation instead. */
export function _resetAppResourceCacheForTests(): void {
    cache.clear();
    refreshHandler = null;
}

// Module-level handler set by the active AppResourceProvider on mount. The sync layer and the
// legacy AppDataProvider call `triggerAppResourceRefresh(scope)` without importing the provider
// or threading context through their call sites — same shape as the SSE EventSource singleton.
type RefreshHandler = (scope?: ResourceScope) => void;
let refreshHandler: RefreshHandler | null = null;

export function registerAppResourceRefreshHandler(handler: RefreshHandler): () => void {
    refreshHandler = handler;
    return () => {
        if (refreshHandler === handler) {
            refreshHandler = null;
        }
    };
}

/** No-op when no provider is mounted (e.g. during boot before _authenticated mounts). */
export function triggerAppResourceRefresh(scope: ResourceScope = 'all'): void {
    refreshHandler?.(scope);
}
