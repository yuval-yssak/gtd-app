import dayjs, { type Dayjs } from 'dayjs';
import type { StoredItem, StoredRoutine } from '../types/MyDB';

export type RoutineNextItemResult = { item: StoredItem } | { item: null; reason: string };

const isOpen = (item: StoredItem) => item.status !== 'done' && item.status !== 'trash';

/** Sort key for next-action routine items: due date first, tickler date next, creation last. */
const nextActionSortKey = (item: StoredItem) => item.expectedBy ?? item.ignoreBefore ?? item.createdTs;

function nextCalendarItem(generated: StoredItem[], now: Dayjs): StoredItem | undefined {
    return (
        generated
            .filter((item) => item.timeStart !== undefined)
            // "Next" = the instance whose end hasn't passed yet (an ongoing event still counts).
            // All-day items store an exclusive YYYY-MM-DD end, so midnight-of-end-day is exactly over.
            .filter((item) => dayjs(item.timeEnd ?? item.timeStart).isAfter(now))
            .sort((a, b) => dayjs(a.timeStart).valueOf() - dayjs(b.timeStart).valueOf())[0]
    );
}

function nextOpenNextAction(generated: StoredItem[]): StoredItem | undefined {
    // Earliest open item wins even when overdue — an overdue routine item is exactly what
    // the user wants to jump to from the routine page.
    return [...generated].sort((a, b) => nextActionSortKey(a).localeCompare(nextActionSortKey(b)))[0];
}

function nextGeneratedItem(routine: StoredRoutine, generated: StoredItem[], now: Dayjs): StoredItem | undefined {
    return routine.routineType === 'calendar' ? nextCalendarItem(generated, now) : nextOpenNextAction(generated);
}

/**
 * Resolve the routine's "immediate next item": the generated item the user would act on next.
 * Returns a human-readable reason when there is none (paused routine / nothing generated yet).
 */
export function findRoutineNextItem(routine: StoredRoutine, items: StoredItem[], now: Dayjs): RoutineNextItemResult {
    const generated = items.filter((item) => item.routineId === routine._id && isOpen(item));
    const next = nextGeneratedItem(routine, generated, now);
    if (next) {
        return { item: next };
    }
    return { item: null, reason: routine.active ? 'No upcoming item yet' : 'No upcoming item — routine is paused' };
}

/**
 * Next items for many routines at once (the /routines list): pre-narrows to open routine-generated
 * items once instead of re-filtering the full item set per routine. Routines with no upcoming
 * item are simply absent from the map.
 */
export function buildRoutineNextItemIndex(routines: StoredRoutine[], items: StoredItem[], now: Dayjs): Map<string, StoredItem> {
    const generatedByRoutine = items.reduce((byRoutine, item) => {
        if (item.routineId !== undefined && isOpen(item)) {
            const generated = byRoutine.get(item.routineId) ?? [];
            generated.push(item);
            byRoutine.set(item.routineId, generated);
        }
        return byRoutine;
    }, new Map<string, StoredItem[]>());
    return new Map(
        routines.flatMap((routine) => {
            const next = nextGeneratedItem(routine, generatedByRoutine.get(routine._id) ?? [], now);
            return next ? [[routine._id, next] as const] : [];
        }),
    );
}

/** Short date label shown next to the next-item link, e.g. "Thu, Jul 2 18:00" or "due Jul 4". */
export function describeNextItemDate(item: StoredItem): string {
    if (item.timeStart) {
        const start = dayjs(item.timeStart);
        return item.allDay ? start.format('ddd, MMM D') : start.format('ddd, MMM D HH:mm');
    }
    if (item.expectedBy) {
        return `due ${dayjs(item.expectedBy).format('MMM D')}`;
    }
    if (item.ignoreBefore) {
        return `hidden until ${dayjs(item.ignoreBefore).format('MMM D')}`;
    }
    return '';
}
