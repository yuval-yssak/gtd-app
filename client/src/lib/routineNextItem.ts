import dayjs, { type Dayjs } from 'dayjs';
import type { StoredItem, StoredRoutine } from '../types/MyDB';

/**
 * `isOverdue` marks a calendar occurrence whose end has already passed but which is still open —
 * surfaced (not hidden) so the user can reach it and mark it done. Always false for nextAction
 * routines, whose overdue handling is carried by their own date fields.
 */
export type RoutineNextItemResult = { item: StoredItem; isOverdue: boolean } | { item: null; reason: string };

const isOpen = (item: StoredItem) => item.status !== 'done' && item.status !== 'trash';

/** Sort key for next-action routine items: due date first, tickler date next, creation last. */
const nextActionSortKey = (item: StoredItem) => item.expectedBy ?? item.ignoreBefore ?? item.createdTs;

/** Chronological by start — the shared ordering for both the upcoming and the overdue partition. */
function byStart(a: StoredItem, b: StoredItem): number {
    return dayjs(a.timeStart).valueOf() - dayjs(b.timeStart).valueOf();
}

/**
 * Has this occurrence's end passed? An ongoing event has not. All-day items store an exclusive
 * YYYY-MM-DD end, so midnight-of-end-day is exactly over.
 */
function hasEnded(item: StoredItem, now: Dayjs): boolean {
    return !dayjs(item.timeEnd ?? item.timeStart).isAfter(now);
}

/**
 * The calendar occurrence the user would act on next. Upcoming (or ongoing) instances win, soonest
 * first. When every open instance is already past, the LATEST one is still returned as overdue
 * rather than nothing: a past-but-undone occurrence is exactly what the user needs to reach in
 * order to mark it done — same rule `nextOpenNextAction` applies to overdue next-actions. Only
 * done/trashed items are filtered out, and that happens in `findRoutineNextItem`.
 */
function nextCalendarItem(generated: StoredItem[], now: Dayjs): StoredItem | undefined {
    const dated = generated.filter((item) => item.timeStart !== undefined).sort(byStart);
    const upcoming = dated.find((item) => !hasEnded(item, now));
    return upcoming ?? dated[dated.length - 1];
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
        return { item: next, isOverdue: routine.routineType === 'calendar' && hasEnded(next, now) };
    }
    return { item: null, reason: routine.active ? 'No item generated yet' : 'No item generated — routine is paused' };
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

/** True when this calendar occurrence's end has passed — an open one is overdue, not upcoming. */
export function isOverdueCalendarItem(item: StoredItem, now = dayjs()): boolean {
    return item.timeStart !== undefined && hasEnded(item, now);
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
