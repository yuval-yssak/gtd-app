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

/** Dates that must be skipped when generating or counting occurrences. Shared between the
 *  generator and the exhaustion check so their notions of "valid occurrence" cannot drift.
 *  - `skipped`: user explicitly trashed this occurrence before due.
 *  - `modified`: an occurrence that was moved to a different day — the original date is no
 *    longer a rrule-backed slot and must not regenerate. `modified` entries whose newTimeStart
 *    stays on the same date are NOT skipped (they're pure time/title/notes overrides). */
function buildExceptionDateSet(routine: StoredRoutine): Set<string> {
    return new Set(
        (routine.routineExceptions ?? [])
            .filter((e) => e.type === 'skipped' || (e.type === 'modified' && typeof e.newTimeStart === 'string' && e.newTimeStart.slice(0, 10) !== e.date))
            .map((e) => e.date),
    );
}

/** Rrule occurrences from today through the horizon, minus any dates carried by exceptions.
 *  The one true source of "future slots that should produce items". */
function getValidFutureOccurrences(routine: StoredRoutine): Date[] {
    const horizonMonths = getCalendarHorizonMonths();
    const startDate = dayjs().startOf('day').subtract(1, 'ms').toDate();
    const endDate = dayjs().add(horizonMonths, 'month').endOf('day').toDate();
    const rule = buildCalendarRule(routine.rrule, dayjs(routine.createdTs).toDate());
    const exceptionDates = buildExceptionDateSet(routine);
    return rule.between(startDate, endDate, false).filter((d) => !exceptionDates.has(d.toISOString().slice(0, 10)));
}

/**
 * Read-only exhaustion check: true when the routine has no live `calendar`-status items AND
 * no future rrule occurrences before the horizon. Used by the disposal path to deactivate
 * one-shot (`COUNT=1`) and otherwise-exhausted routines without invoking the generator.
 * MUST stay aligned with `generateCalendarItemsToHorizon`'s exhaustion predicate — both
 * branch on the same `(validOccurrences, liveCalendarItems)` signal, so the shared helpers
 * above are the single source of truth for that condition.
 */
export async function isCalendarRoutineExhausted(db: IDBPDatabase<MyDB>, userId: string, routine: StoredRoutine): Promise<boolean> {
    if (getValidFutureOccurrences(routine).length > 0) {
        return false;
    }
    const items = await db.getAllFromIndex('items', 'userId', userId);
    return !items.some((i) => i.routineId === routine._id && i.status === 'calendar');
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

    const validOccurrences = getValidFutureOccurrences(routine);
    // Dedupe against any item tied to this routine regardless of status — a `done`/`trash` item on
    // a given date still "claims" that occurrence, so the user doesn't get a duplicate calendar item
    // when the horizon is re-extended on disposal (matrix A8).
    const allRoutineItems = (await db.getAllFromIndex('items', 'userId', userId)).filter((i) => i.routineId === routine._id);
    // Filter out items without a timeStart (e.g. an inbox item briefly re-attached to the routine)
    // so they don't seed an empty-string date key that would spuriously match against slice(0,10).
    const existingDates = new Set(allRoutineItems.map((i) => i.timeStart?.slice(0, 10)).filter((d): d is string => Boolean(d)));
    // Exhaustion check uses only live `calendar` items — a series with only disposed (done/trash)
    // items and no future occurrences is genuinely over, even if historical items remain.
    const liveCalendarItems = allRoutineItems.filter((i) => i.status === 'calendar');

    // If the series is exhausted (no future occurrences at all), signal to the caller
    if (validOccurrences.length === 0 && liveCalendarItems.length === 0) {
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

/**
 * Update title/notes on all future calendar items whose content isn't overridden by a
 * per-instance `routineExceptions` entry. Preserves item IDs (and hence GCal event IDs
 * and any existing overrides) so a simple master rename never deletes and recreates items.
 */
export async function regenerateFutureItemContent(db: IDBPDatabase<MyDB>, userId: string, routine: StoredRoutine): Promise<void> {
    const todayStr = dayjs().startOf('day').format('YYYY-MM-DD');
    const now = dayjs().toISOString();
    const allItems = await db.getAllFromIndex('items', 'userId', userId);
    const futureItems = allItems.filter((i) => i.routineId === routine._id && i.status === 'calendar' && (i.timeStart ?? '') >= todayStr);
    const exceptions = routine.routineExceptions ?? [];
    const masterNotes = routine.template.notes;

    for (const item of futureItems) {
        const dateStr = (item.timeStart ?? '').slice(0, 10);
        const override = exceptions.find((e) => e.type === 'modified' && e.date === dateStr);
        const nextTitle = override?.title ?? routine.title;
        const nextNotes = override?.notes ?? masterNotes;

        if (item.title === nextTitle && (item.notes ?? undefined) === (nextNotes ?? undefined)) {
            continue;
        }

        const updated: StoredItem = {
            ...item,
            title: nextTitle,
            ...(nextNotes ? { notes: nextNotes } : {}),
            updatedTs: now,
        };
        if (!nextNotes) {
            delete updated.notes;
        }
        await putItem(db, updated);
        await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated });
    }
}
