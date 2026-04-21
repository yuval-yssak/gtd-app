import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { RRule } from 'rrule';
import { getCalendarHorizonMonths } from '../lib/calendarHorizon';
import { computeNextOccurrence } from '../lib/rruleUtils';
import type { MyDB, StoredItem, StoredRoutine } from '../types/MyDB';
import { putItem } from './itemHelpers';
import { updateRoutine } from './routineMutations';
import { queueSyncOp } from './syncHelpers';

/**
 * Create the next nextAction item for a routine, scheduling it for the first rrule occurrence
 * after completionDate. Called whenever a routine-linked item is marked done or trashed,
 * regardless of the item's current status — this ensures continuity even if the item was
 * transformed to inbox/calendar/waitingFor before being completed.
 */
export async function createNextRoutineItem(db: IDBPDatabase<MyDB>, userId: string, routine: StoredRoutine, completionDate: Date): Promise<void> {
    const nextDueDate = computeNextOccurrence(routine.rrule, completionDate);
    const expectedBy = dayjs(nextDueDate).format('YYYY-MM-DD');

    const now = dayjs().toISOString();
    const item = {
        _id: crypto.randomUUID(),
        userId,
        status: 'nextAction' as const,
        title: routine.title,
        routineId: routine._id,
        expectedBy,
        // Routine-generated items are hidden until their due date (tickler pattern)
        ignoreBefore: expectedBy,
        ...(routine.template.workContextIds ? { workContextIds: routine.template.workContextIds } : {}),
        ...(routine.template.peopleIds ? { peopleIds: routine.template.peopleIds } : {}),
        ...(routine.template.energy ? { energy: routine.template.energy } : {}),
        ...(routine.template.time !== undefined ? { time: routine.template.time } : {}),
        ...(routine.template.focus !== undefined ? { focus: routine.template.focus } : {}),
        ...(routine.template.urgent !== undefined ? { urgent: routine.template.urgent } : {}),
        ...(routine.template.notes ? { notes: routine.template.notes } : {}),
        createdTs: now,
        updatedTs: now,
    };

    await putItem(db, item);
    await queueSyncOp(db, { opType: 'create', entityType: 'item', entityId: item._id, snapshot: item });
}

// ── Calendar routine helpers ───────────────────────────────────────────────────

/**
 * Thrown when a calendar routine's rrule series is fully exhausted (UNTIL/COUNT reached or all
 * occurrences are in the exception list). Callers catch this to deactivate the routine rather
 * than logging a generic error.
 */
export class RruleExhaustedError extends Error {}

/**
 * Build an RRule anchored to the routine's creation date (UTC midnight) for calendar routines.
 * Uses DTSTART at UTC midnight via RRule.fromString (not the `new RRule({ dtstart })` constructor)
 * because rrule 2.8.1 does not reliably preserve the dtstart time when passed as a Date object —
 * occurrences end up at the current wall-clock time instead. Parsing from a DTSTART string anchors
 * occurrences to 00:00:00Z, and we extract dates with .toISOString().slice(0, 10) for UTC-safe
 * comparison that works in all timezones.
 */
function buildCalendarRule(rruleStr: string, dtstart: Date): RRule {
    const dtStartStr = `${dayjs(dtstart).toISOString().slice(0, 10).replace(/-/g, '')}T000000Z`;
    return RRule.fromString(`DTSTART:${dtStartStr}\nRRULE:${rruleStr}`);
}

/** Return the first rrule occurrence strictly after `afterDate`, skipping any exception dates. */
function computeNextCalendarDate(rruleStr: string, dtstart: Date, afterDate: Date, exceptions: string[]): Date {
    const rule = buildCalendarRule(rruleStr, dtstart);
    let candidate = rule.after(afterDate, false);
    while (candidate) {
        if (!exceptions.includes(candidate.toISOString().slice(0, 10))) {
            return candidate;
        }
        candidate = rule.after(candidate, false);
    }
    throw new RruleExhaustedError(`rrule "${rruleStr}" exhausted after ${dayjs(afterDate).toISOString()}`);
}

/**
 * Determine whether a calendar item was completed on time or late.
 * 'late' means the item was completed more than 24 hours after its scheduled start —
 * in that case the next occurrence advances from now rather than from the original timeStart.
 */
export function getCalendarCompletionTiming(timeStart: string, completionDate: Date): 'onTime' | 'late' {
    return dayjs(completionDate).isAfter(dayjs(timeStart).add(24, 'hour')) ? 'late' : 'onTime';
}

/**
 * Create the next calendar item for a routine.
 * `refDate` determines the search start for the next rrule occurrence:
 *   - pass `item.timeStart` (onTime) to advance to the next occurrence after the item's date
 *   - pass `completionDate` (late) to advance from the actual completion time
 *
 * Also updates `routine.lastGeneratedDate` so the next call knows where to start without
 * scanning items.
 */
export async function createNextCalendarItem(db: IDBPDatabase<MyDB>, userId: string, routine: StoredRoutine, refDate: Date): Promise<void> {
    const { calendarItemTemplate } = routine;
    if (!calendarItemTemplate) {
        throw new Error(`[routine] calendar routine ${routine._id} is missing calendarItemTemplate`);
    }

    const exceptions = (routine.routineExceptions ?? []).map((e) => e.date);
    const dtstart = dayjs(routine.createdTs).toDate();
    const nextDate = computeNextCalendarDate(routine.rrule, dtstart, refDate, exceptions);

    // timeOfDay is a user-local time (HH:MM), so both timeStart and timeEnd are stored as naive
    // local-time strings (no Z suffix) to avoid an implicit UTC conversion via .toISOString().
    // nextDate is at 00:00:00Z (from computeNextCalendarDate), so .toISOString().slice(0,10)
    // gives the correct UTC calendar date regardless of the local timezone.
    const timeStart = `${nextDate.toISOString().slice(0, 10)}T${calendarItemTemplate.timeOfDay}:00`;
    const timeEnd = dayjs(timeStart).add(calendarItemTemplate.duration, 'minute').format('YYYY-MM-DDTHH:mm:ss');

    const now = dayjs().toISOString();
    const item = {
        _id: crypto.randomUUID(),
        userId,
        status: 'calendar' as const,
        title: routine.title,
        routineId: routine._id,
        timeStart,
        timeEnd,
        ...(routine.template.notes ? { notes: routine.template.notes } : {}),
        createdTs: now,
        updatedTs: now,
    };

    await putItem(db, item);
    await queueSyncOp(db, { opType: 'create', entityType: 'item', entityId: item._id, snapshot: item });

    // Record the generated date so the next completion can advance from here without scanning items
    await updateRoutine(db, { ...routine, lastGeneratedDate: dayjs(nextDate).format('YYYY-MM-DD') });
}

// ── Horizon-based batch generation ───────────────────────────────────────────

/** Build a calendar item for a single rrule occurrence date. */
function buildCalendarItem(
    userId: string,
    routine: StoredRoutine,
    occurrenceDate: Date,
    now: string,
    template: { timeOfDay: string; duration: number },
): StoredItem {
    const dateStr = occurrenceDate.toISOString().slice(0, 10);
    const timeStart = `${dateStr}T${template.timeOfDay}:00`;
    const timeEnd = dayjs(timeStart).add(template.duration, 'minute').format('YYYY-MM-DDTHH:mm:ss');

    // Check for content overrides from GCal single-occurrence edits
    const contentException = (routine.routineExceptions ?? []).find((e) => e.type === 'modified' && e.date === dateStr);
    const title = contentException?.title ?? routine.title;
    const notes = contentException?.notes ?? routine.template.notes;

    return {
        _id: crypto.randomUUID(),
        userId,
        status: 'calendar' as const,
        title,
        routineId: routine._id,
        timeStart,
        timeEnd,
        ...(notes ? { notes } : {}),
        createdTs: now,
        updatedTs: now,
    };
}

/**
 * Generate calendar items for all rrule occurrences from now until the user's horizon.
 * Skips exception dates and dates that already have items, then persists and queues sync ops.
 */
export async function generateCalendarItemsToHorizon(db: IDBPDatabase<MyDB>, userId: string, routine: StoredRoutine): Promise<void> {
    const { calendarItemTemplate } = routine;
    if (!calendarItemTemplate) {
        throw new Error(`[routine] calendar routine ${routine._id} is missing calendarItemTemplate`);
    }

    const horizonMonths = getCalendarHorizonMonths();
    const startDate = dayjs().startOf('day').subtract(1, 'ms').toDate();
    const endDate = dayjs().add(horizonMonths, 'month').endOf('day').toDate();

    const dtstart = dayjs(routine.createdTs).toDate();
    const rule = buildCalendarRule(routine.rrule, dtstart);
    const occurrences = rule.between(startDate, endDate, false);

    // Exclude any exception date from regeneration:
    // - 'skipped' dates the user explicitly trashed before due.
    // - 'modified' dates whose override moved the occurrence to a different day — without this,
    //   the next horizon pass would generate a fresh item for the original date, duplicating
    //   the one the user already moved.
    const exceptionDates = new Set(
        (routine.routineExceptions ?? [])
            .filter((e) => e.type === 'skipped' || (e.type === 'modified' && typeof e.newTimeStart === 'string' && e.newTimeStart.slice(0, 10) !== e.date))
            .map((e) => e.date),
    );
    const existingItems = (await db.getAllFromIndex('items', 'userId', userId)).filter((i) => i.routineId === routine._id && i.status === 'calendar');
    const existingDates = new Set(existingItems.map((i) => (i.timeStart ?? '').slice(0, 10)));

    const validOccurrences = occurrences.filter((d) => !exceptionDates.has(d.toISOString().slice(0, 10)));

    // If the series is exhausted (no future occurrences at all), signal to the caller
    if (validOccurrences.length === 0 && existingItems.length === 0) {
        throw new RruleExhaustedError(`rrule "${routine.rrule}" has no occurrences in the horizon`);
    }

    const newDates = validOccurrences.filter((d) => !existingDates.has(d.toISOString().slice(0, 10)));

    const now = dayjs().toISOString();
    for (const date of newDates) {
        const item = buildCalendarItem(userId, routine, date, now, calendarItemTemplate);
        await putItem(db, item);
        await queueSyncOp(db, { opType: 'create', entityType: 'item', entityId: item._id, snapshot: item });
    }

    const lastDate = validOccurrences.at(-1);
    if (lastDate) {
        await updateRoutine(db, { ...routine, lastGeneratedDate: dayjs(lastDate).format('YYYY-MM-DD') });
    }
}

/**
 * Delete future calendar items for a routine starting from a given date.
 * Used during a routine split to remove items that the tail routine will regenerate.
 */
export async function deleteFutureItemsFromDate(db: IDBPDatabase<MyDB>, userId: string, routineId: string, fromDate: string): Promise<void> {
    const allItems = await db.getAllFromIndex('items', 'userId', userId);
    const futureItems = allItems.filter((i) => i.routineId === routineId && i.status === 'calendar' && (i.timeStart ?? '') >= fromDate);

    for (const item of futureItems) {
        await db.delete('items', item._id);
        await queueSyncOp(db, { opType: 'delete', entityType: 'item', entityId: item._id, snapshot: null });
    }
}

/**
 * Delete all future calendar items for a routine and regenerate up to the horizon.
 * Called when the rrule changes so items reflect the new schedule.
 */
export async function deleteAndRegenerateFutureItems(db: IDBPDatabase<MyDB>, userId: string, routine: StoredRoutine): Promise<void> {
    const now = dayjs().startOf('day').format('YYYY-MM-DD');
    const allItems = await db.getAllFromIndex('items', 'userId', userId);
    const futureItems = allItems.filter((i) => i.routineId === routine._id && i.status === 'calendar' && (i.timeStart ?? '') >= now);

    for (const item of futureItems) {
        await db.delete('items', item._id);
        await queueSyncOp(db, { opType: 'delete', entityType: 'item', entityId: item._id, snapshot: null });
    }

    await generateCalendarItemsToHorizon(db, userId, routine);
}
