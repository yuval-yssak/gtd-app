import type { IDBPDatabase } from 'idb';
import { getItemsAcrossUsers } from '../db/itemHelpers';
import { getPeopleAcrossUsers } from '../db/personHelpers';
import { getRoutinesAcrossUsers } from '../db/routineHelpers';
import { getWorkContextsAcrossUsers } from '../db/workContextHelpers';
import type { MyDB, StoredItem, StoredPerson, StoredRoutine, StoredWorkContext } from '../types/MyDB';

/**
 * Per-user-set bundle of promises that components `use()`. The fields are kept independent so
 * a scoped invalidation (e.g. only items changed) doesn't make every list page re-suspend.
 */
export interface AppResourceSnapshot {
    items: Promise<StoredItem[]>;
    routines: Promise<StoredRoutine[]>;
    people: Promise<StoredPerson[]>;
    workContexts: Promise<StoredWorkContext[]>;
}

export type ResourceScope = 'items' | 'routines' | 'people' | 'workContexts' | 'all';

interface CacheEntry {
    db: IDBPDatabase<MyDB>;
    userIds: readonly string[];
    snapshot: AppResourceSnapshot;
}

// Module-level cache. Keyed on a stable string of `<dbName>|<sortedUserIds>` so the same
// (db, users) pair always returns the same snapshot — that identity is what lets two
// components `use()` the same field without firing two IDB reads.
const cache = new Map<string, CacheEntry>();

function keyFor(db: IDBPDatabase<MyDB>, userIds: readonly string[]): string {
    const sorted = [...userIds].sort().join(',');
    return `${db.name}|${sorted}`;
}

function buildSnapshot(db: IDBPDatabase<MyDB>, userIds: readonly string[]): AppResourceSnapshot {
    const ids = [...userIds];
    return {
        items: getItemsAcrossUsers(db, ids),
        routines: getRoutinesAcrossUsers(db, ids),
        people: getPeopleAcrossUsers(db, ids),
        workContexts: getWorkContextsAcrossUsers(db, ids),
    };
}

/**
 * Returns the stable snapshot of promises for this (db, userIds) pair. Repeat calls with the
 * same arguments return the *same* promise references — that's what enables Suspense to dedupe.
 */
export function getAppResource(db: IDBPDatabase<MyDB>, userIds: readonly string[]): AppResourceSnapshot {
    const key = keyFor(db, userIds);
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
    const key = keyFor(db, userIds);
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
    }
}

/** Test-only: drops the entire module cache. Real code should use scoped invalidation instead. */
export function _resetAppResourceCacheForTests(): void {
    cache.clear();
}
