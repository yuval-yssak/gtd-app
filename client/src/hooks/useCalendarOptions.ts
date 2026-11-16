import type { IDBPDatabase } from 'idb';
import { use, useSyncExternalStore } from 'react';
import { getAllSyncConfigs } from '../api/calendarApi';
import { readStoredCalendarOptions, storeCalendarOptionBundles } from '../db/calendarOptionsStore';
import type { CalendarOption, MyDB } from '../types/MyDB';

export type { CalendarOption } from '../types/MyDB';

/**
 * A background refresh stops waiting after this long. Without it a request on a hanging network
 * stays in flight for minutes, and every later refresh joins it instead of trying again.
 */
export const CALENDAR_OPTIONS_FETCH_DEADLINE_MS = 15_000;

type Listener = () => void;

// The editors render from IndexedDB, never from the network: `stored` is the device's list (one IDB
// read per page, then replaced by each successful refresh), and `listeners` re-render readers when a
// refresh lands. Module state so every editor shares one read.
const cache: { stored: Promise<CalendarOption[]> | null; refreshInFlight: Promise<void> | null; version: number } = {
    stored: null,
    refreshInFlight: null,
    version: 0,
};
const listeners = new Set<Listener>();

function loadStoredCalendarOptions(db: IDBPDatabase<MyDB>): Promise<CalendarOption[]> {
    // A failed read settles on no options and stays cached: dropping it would make every render of
    // a use() reader start a new read and suspend again.
    cache.stored ??= readStoredCalendarOptions(db).catch(() => []);
    return cache.stored;
}

/**
 * A promise React's use() can read synchronously: it reads a thenable's `status`/`value` tags
 * before subscribing, so an already-settled swap renders at once instead of suspending for a tick.
 */
function settledPromise<T>(value: T) {
    return Object.assign(Promise.resolve(value), { status: 'fulfilled' as const, value });
}

function announceRefresh(options: CalendarOption[]): void {
    cache.stored = settledPromise(options);
    cache.version += 1;
    for (const listener of listeners) {
        listener();
    }
}

async function fetchAndStoreCalendarOptions(db: IDBPDatabase<MyDB>): Promise<void> {
    try {
        await storeCalendarOptionBundles(db, await getAllSyncConfigs(CALENDAR_OPTIONS_FETCH_DEADLINE_MS));
        announceRefresh(await readStoredCalendarOptions(db));
    } catch (err) {
        // Best-effort: the stored list stays on screen, and the next sync refreshes again.
        console.log('[calendarOptions] refresh failed; keeping the stored list', { err });
    }
}

/**
 * Fetches the calendar list in the background and stores it on the device; mounted editors pick the
 * new list up without suspending. Never rejects. Overlapping calls share one request.
 */
export function refreshCalendarOptions(db: IDBPDatabase<MyDB>): Promise<void> {
    cache.refreshInFlight ??= fetchAndStoreCalendarOptions(db).finally(() => {
        cache.refreshInFlight = null;
    });
    return cache.refreshInFlight;
}

function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/**
 * The calendars the item and routine editors offer, read from IndexedDB. Suspends only for that
 * local read — never on the network, so an editor renders the same on a hanging connection as
 * offline. A refresh that lands later re-renders the reader with the new list.
 */
export function useCalendarOptions(db: IDBPDatabase<MyDB>): { options: CalendarOption[] } {
    // Subscribed for the re-render only; the list itself comes from the cached promise below.
    useSyncExternalStore(subscribe, () => cache.version);
    const options = use(loadStoredCalendarOptions(db));
    return { options };
}

/** Test-only — drops the module cache so each spec starts cold. */
export function _resetCalendarOptionsCacheForTests(): void {
    cache.stored = null;
    cache.refreshInFlight = null;
    cache.version = 0;
    listeners.clear();
}
