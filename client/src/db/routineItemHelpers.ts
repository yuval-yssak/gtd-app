import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { RRule } from 'rrule';
import { computeNextOccurrence } from '../lib/rruleUtils';
import type { MyDB, StoredRoutine } from '../types/MyDB';
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
 * Return the first rrule occurrence strictly after `afterDate`, skipping any exception dates.
 * DTSTART is fixed to the routine's creation date (calendar routines use absolute scheduling,
 * not completion-relative scheduling like next-action routines).
 *
 * Uses DTSTART at UTC midnight via RRule.fromString (not the `new RRule({ dtstart })` constructor)
 * because rrule 2.8.1 does not reliably preserve the dtstart time when passed as a Date object —
 * occurrences end up at the current wall-clock time instead. Parsing from a DTSTART string anchors
 * occurrences to 00:00:00Z, and we extract dates with .toISOString().slice(0, 10) for UTC-safe
 * comparison that works in all timezones.
 */
function computeNextCalendarDate(rruleStr: string, dtstart: Date, afterDate: Date, exceptions: string[]): Date {
    const dtStartStr = `${dayjs(dtstart).toISOString().slice(0, 10).replace(/-/g, '')}T000000Z`;
    const rule = RRule.fromString(`DTSTART:${dtStartStr}\nRRULE:${rruleStr}`);
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
