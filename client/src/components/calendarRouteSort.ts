/**
 * Pure grouping + sorting helpers for the calendar route. Extracted so the in-route component
 * stays focused on rendering, and so the rules below can be unit-tested without a render env.
 *
 * Rules:
 * - Items group by their "display date" — for all-day events that is the start date verbatim
 *   (YYYY-MM-DD already), for timed events the UTC-rendered date of `timeStart`. Multi-day
 *   all-day events appear ONLY under their start date (not on subsequent days in the range).
 * - Within a group: all-day events first, alphabetical by title, then timed events sorted by
 *   `timeStart`. No-date items collect under a sentinel bucket.
 */
import dayjs from 'dayjs';
import type { StoredItem } from '../types/MyDB';

export const NO_DATE_KEY = 'No date';

/**
 * The bucket key used to group an item under a single day. For all-day items the `timeStart`
 * already looks like YYYY-MM-DD (GCal naïve date), so we use it verbatim — no tz application,
 * which would shift the day in negative-offset zones. Timed items fall back to dayjs formatting.
 */
export function groupingKeyFor(item: StoredItem): string {
    if (!item.timeStart) return NO_DATE_KEY;
    if (item.allDay) return item.timeStart;
    return dayjs(item.timeStart).format('YYYY-MM-DD');
}

/**
 * Comparator within a single day's bucket. All-day events sort before timed events; ties broken
 * by title (all-day) or `timeStart` (timed). Used directly by `Array.prototype.sort`.
 *
 * Timed events are compared as parsed instants, NOT raw strings: `timeStart` is stored
 * inconsistently — GCal-synced items as UTC (`…Z`), in-app items as floating local (no offset).
 * A lexical compare on those mixed formats orders them wrong (e.g. `05:45Z` < `08:30` as strings
 * even though 08:45 local is the later instant). dayjs normalizes both to an epoch ms first.
 */
export function compareWithinDay(a: StoredItem, b: StoredItem): number {
    const aAllDay = a.allDay === true;
    const bAllDay = b.allDay === true;
    if (aAllDay !== bAllDay) return aAllDay ? -1 : 1;
    if (aAllDay && bAllDay) return a.title.localeCompare(b.title);
    return dayjs(a.timeStart).valueOf() - dayjs(b.timeStart).valueOf();
}

/**
 * Groups + sorts a list of calendar items into a per-day map. Object insertion order is
 * preserved by sorting keys ascending (No-date sentinel pinned to the end) so `Object.entries`
 * yields a stable, chronological iteration for the route's render loop.
 */
export function groupCalendarItemsByDay(items: readonly StoredItem[]): Record<string, StoredItem[]> {
    const buckets = items.reduce<Record<string, StoredItem[]>>((acc, item) => {
        const key = groupingKeyFor(item);
        acc[key] = [...(acc[key] ?? []), item];
        return acc;
    }, {});
    const sortedKeys = Object.keys(buckets).sort(compareDayKeys);
    return sortedKeys.reduce<Record<string, StoredItem[]>>((acc, key) => {
        const groupItems = buckets[key] ?? [];
        acc[key] = [...groupItems].sort(compareWithinDay);
        return acc;
    }, {});
}

/** Day-key comparator: ISO dates ascending; the No-date sentinel sorts last. */
function compareDayKeys(a: string, b: string): number {
    if (a === NO_DATE_KEY) return 1;
    if (b === NO_DATE_KEY) return -1;
    return a.localeCompare(b);
}

/**
 * True when an all-day item spans more than one day. GCal `timeEnd` is exclusive, so a single-day
 * all-day event has end = start + 1 day (diff === 1). Two-day-or-longer events satisfy diff > 1.
 */
export function isMultiDayAllDay(item: StoredItem): boolean {
    if (!item.allDay || !item.timeStart || !item.timeEnd) return false;
    return dayjs(item.timeEnd).diff(dayjs(item.timeStart), 'day') > 1;
}
