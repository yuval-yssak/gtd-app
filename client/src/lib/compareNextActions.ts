import dayjs from 'dayjs';
import type { StoredItem } from '../types/MyDB';
import { compareRank } from './itemRank';

/**
 * The calendar day an item's `expectedBy` falls on, in the device's local zone, or null when
 * undated. `expectedBy` may be a `YYYY-MM-DD` (passes through unchanged) or an ISO datetime
 * (collapses to its local day), so two items due the same day always share a key.
 */
export function expectedDayKey(item: Pick<StoredItem, 'expectedBy'>): string | null {
    return item.expectedBy ? dayjs(item.expectedBy).format('YYYY-MM-DD') : null;
}

// A sort parses each row O(log n) times; rows are immutable snapshots re-created on refresh, so a
// per-object cache turns that into one dayjs parse per row per refresh.
const dayKeyCache = new WeakMap<object, string | null>();

function cachedDayKey(item: StoredItem): string | null {
    const cached = dayKeyCache.get(item);
    if (cached !== undefined) {
        return cached;
    }
    const key = expectedDayKey(item);
    dayKeyCache.set(item, key);
    return key;
}

/**
 * Next Actions order — "date is a gate, rank is the order inside it". Shared by the Next Actions
 * page and the weekly-review wizard so both walk items in the same order. The order is TOTAL
 * (every tie is broken by `_id`), so it never flickers between renders or devices.
 *
 *  1. `expectedDayKey` ascending, undated last;
 *  2. inside one day: items WITHOUT a `rank` first, newest `createdTs` first — an item from a
 *     pre-rollout client or a `/v1/operations/batch` create is "new" and lands where a fresh item
 *     lands (the top of its section);
 *  3. then `rank` ascending by code unit (`compareRank`), never `localeCompare` — the key alphabet
 *     is ASCII-ordered and ICU collation would sort `a0` before `B0`;
 *  4. `_id` ascending breaks every remaining tie (equal ranks from concurrent mints, same-ms
 *     `createdTs`).
 */
export function compareNextActions(a: StoredItem, b: StoredItem): number {
    const dayDiff = compareDayKeys(cachedDayKey(a), cachedDayKey(b));
    if (dayDiff !== 0) {
        return dayDiff;
    }
    const withinDay = compareWithinDay(a, b);
    return withinDay !== 0 ? withinDay : compareCodeUnits(a._id, b._id);
}

function compareDayKeys(a: string | null, b: string | null): number {
    if (a === b) {
        return 0;
    }
    if (a === null || b === null) {
        return a === null ? 1 : -1;
    }
    return compareCodeUnits(a, b);
}

function compareWithinDay(a: StoredItem, b: StoredItem): number {
    if (a.rank !== undefined && b.rank !== undefined) {
        return compareRank(a.rank, b.rank);
    }
    if (a.rank !== undefined || b.rank !== undefined) {
        return a.rank === undefined ? -1 : 1;
    }
    return compareCodeUnits(b.createdTs, a.createdTs);
}

function compareCodeUnits(a: string, b: string): number {
    if (a < b) {
        return -1;
    }
    return a > b ? 1 : 0;
}
