import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import rrule from 'rrule';
import itemsDAO from '../dataAccess/itemsDAO.js';
import type { ItemInterface, OperationInterface, RoutineInterface } from '../types/entities.js';
import { recordOperation } from './operationHelpers.js';

dayjs.extend(utc);
dayjs.extend(timezone);

// rrule@2.8.1 ships CJS as `main`; default-import + destructure works across Node ESM/Vitest.
const { RRule } = rrule;

// Server-side horizon: match the client's default so bulk regeneration on GCal pull-back produces
// the same window the client would have produced. The client's configurable per-device horizon
// cannot be read here — if the server generates fewer items than the client would, the client's
// own generator will fill any remaining gap; if more, the extras are harmless.
const HORIZON_MONTHS = 2;

/**
 * Build an RRule anchored to the routine's creation date (UTC midnight) for calendar routines.
 * Mirrors the client-side helper in `client/src/db/routineItemHelpers.ts` so both generators
 * produce identical occurrence sets.
 */
function buildCalendarRule(rruleStr: string, dtstart: Date): InstanceType<typeof RRule> {
    const dtStartStr = `${dayjs(dtstart).toISOString().slice(0, 10).replace(/-/g, '')}T000000Z`;
    return RRule.fromString(`DTSTART:${dtStartStr}\nRRULE:${rruleStr}`);
}

/** Exception dates that must be skipped when regenerating (skipped or cross-date modified). */
function buildExceptionDateSet(routine: RoutineInterface): Set<string> {
    const exceptions = routine.routineExceptions ?? [];
    return new Set(
        exceptions
            .filter((e) => e.type === 'skipped' || (e.type === 'modified' && typeof e.newTimeStart === 'string' && e.newTimeStart.slice(0, 10) !== e.date))
            .map((e) => e.date),
    );
}

/** Rrule occurrences from today through the horizon, minus any dates carried by exceptions. */
function getValidFutureOccurrences(routine: RoutineInterface): Date[] {
    const startDate = dayjs().startOf('day').subtract(1, 'ms').toDate();
    const endDate = dayjs().add(HORIZON_MONTHS, 'month').endOf('day').toDate();
    // Parse the anchor as UTC so a startDate like "2026-06-15" doesn't shift a day in non-UTC TZs.
    const anchorTs = routine.startDate ?? routine.createdTs;
    const rule = buildCalendarRule(routine.rrule, dayjs.utc(anchorTs.slice(0, 10)).toDate());
    const exceptionDates = buildExceptionDateSet(routine);
    return rule.between(startDate, endDate, false).filter((d) => !exceptionDates.has(d.toISOString().slice(0, 10)));
}

/**
 * GCal instance event id for a recurring-series occurrence — matches what Google returns in
 * `event.id` for instances of a recurring event.
 *
 * Format depends on whether the series is all-day or timed:
 *  - Timed:   `<masterEventId>_<YYYYMMDDTHHMMSSZ>` — date/time portion is the original occurrence
 *             start converted to UTC (basic ISO 8601, no separators). Pass the routine's local
 *             `timeOfDay` + the calendar `timeZone`.
 *  - All-day: `<masterEventId>_<YYYYMMDD>` — date only, no T component. Pass `timeOfDay = undefined`;
 *             `timeZone` is ignored.
 *
 * Computed deterministically from the routine template so exception sync can locate the item by
 * `calendarInstanceEventId` even after a prior exception has shifted its `timeStart`.
 */
export function buildCalendarInstanceEventId(masterEventId: string, occurrenceDate: Date, timeOfDay: string | undefined, timeZone: string): string {
    const dateStr = occurrenceDate.toISOString().slice(0, 10);
    if (timeOfDay === undefined) {
        // All-day instance suffix: YYYYMMDD only — matches what GCal returns for all-day series instances.
        return `${masterEventId}_${dateStr.replace(/-/g, '')}`;
    }
    // The routine's `timeOfDay` is a wall-clock time in the calendar's TZ. Reconstruct the original
    // instance start as UTC and emit in the YYYYMMDDTHHMMSSZ basic-ISO form GCal uses for instance ids.
    const utcStart = dayjs.tz(`${dateStr}T${timeOfDay}:00`, timeZone).utc().format('YYYYMMDDTHHmmss[Z]');
    return `${masterEventId}_${utcStart}`;
}

/**
 * Build a calendar item for a single rrule occurrence date. Mirrors the client-side helper.
 * When the routine is linked to GCal and a `timeZone` is supplied, also sets
 * `calendarInstanceEventId` so exception sync can re-locate the item after a move.
 *
 * Calendar link inheritance: copies `calendarIntegrationId` + `calendarSyncConfigId` from the
 * routine so UI/audit queries that filter by integration see all routine-generated items
 * uniformly, regardless of which path created them. Pushback skips routine-linked items so
 * leaving these set won't cause a duplicate event, but the rendering/grouping side needs them.
 * Matches the shape used by `createItemForOrphanedException` for the orphan-create path.
 */
function buildCalendarItem(userId: string, routine: RoutineInterface, occurrenceDate: Date, now: string, timeZone?: string): ItemInterface {
    const template = routine.calendarItemTemplate;
    if (!template) {
        throw new Error(`[routine] calendar routine ${routine._id} is missing calendarItemTemplate`);
    }
    const dateStr = occurrenceDate.toISOString().slice(0, 10);
    const timing = buildItemTiming(routine, template, dateStr);

    const contentException = (routine.routineExceptions ?? []).find((e) => e.type === 'modified' && e.date === dateStr);
    const title = contentException?.title ?? routine.title;
    const notes = contentException?.notes ?? routine.template.notes;

    // Only routines linked to GCal produce instance ids — in-app routines have nothing to key on.
    // Window note: between a GCal master-time edit and the next inbound sync, in-flight exceptions
    // carry `googleEventId` derived from the OLD master time while a regen'd item carries the NEW
    // time → preferred lookup misses → create-on-miss inserts a duplicate row. The `(user,
    // calendarInstanceEventId)` unique partial index catches concurrent duplicates within a sync
    // window, but a stale exception batch arriving after regen is its own narrow window we can't
    // close from here — the next full inbound resolves it.
    // All-day uses YYYYMMDD only; timed uses YYYYMMDDTHHMMSSZ via the calendar TZ. The caller
    // skips timeZone for in-app routines so we never emit an instance id without a real link.
    const instanceEventId =
        routine.calendarEventId && (template.allDay === true || timeZone)
            ? buildCalendarInstanceEventId(routine.calendarEventId, occurrenceDate, template.timeOfDay, timeZone ?? 'UTC')
            : undefined;

    return {
        _id: randomUUID(),
        user: userId,
        status: 'calendar',
        title,
        routineId: routine._id,
        timeStart: timing.timeStart,
        timeEnd: timing.timeEnd,
        ...(template.allDay === true ? { allDay: true as const } : {}),
        ...(notes ? { notes } : {}),
        ...(routine.calendarIntegrationId ? { calendarIntegrationId: routine.calendarIntegrationId } : {}),
        ...(routine.calendarSyncConfigId ? { calendarSyncConfigId: routine.calendarSyncConfigId } : {}),
        ...(instanceEventId ? { calendarInstanceEventId: instanceEventId } : {}),
        createdTs: now,
        updatedTs: now,
    };
}

/**
 * Build timeStart/timeEnd for a generated calendar item. Branches on the template's `allDay` flag:
 *  - all-day: timeStart = YYYY-MM-DD, timeEnd = next day (GCal exclusive-end convention).
 *  - timed:   timeStart = `${date}T${timeOfDay}:00`, timeEnd = +duration minutes.
 */
function buildItemTiming(
    routine: RoutineInterface,
    template: NonNullable<RoutineInterface['calendarItemTemplate']>,
    dateStr: string,
): { timeStart: string; timeEnd: string } {
    if (template.allDay === true) {
        return { timeStart: dateStr, timeEnd: dayjs(dateStr).add(1, 'day').format('YYYY-MM-DD') };
    }
    const { timeOfDay, duration } = template;
    if (timeOfDay === undefined || duration === undefined) {
        throw new Error(`[routine] calendar routine ${routine._id} template missing timeOfDay/duration for a timed routine`);
    }
    const timeStart = `${dateStr}T${timeOfDay}:00`;
    return { timeStart, timeEnd: dayjs(timeStart).add(duration, 'minute').format('YYYY-MM-DDTHH:mm:ss') };
}

/**
 * Propagates a GCal master-level title edit to all future calendar items belonging to the routine.
 * Preserves item IDs (and any per-instance overrides) so this is a rename, not a regenerate.
 * Title overrides recorded via `routineExceptions` win — skip those items.
 */
export async function propagateRoutineTitleToItems(routine: RoutineInterface, userId: string, now: string): Promise<OperationInterface[]> {
    const todayStr = dayjs().startOf('day').format('YYYY-MM-DD');
    const items = await itemsDAO.findArray({ user: userId, routineId: routine._id, status: 'calendar' });
    const overriddenDates = new Set((routine.routineExceptions ?? []).filter((e) => e.type === 'modified' && typeof e.title === 'string').map((e) => e.date));

    const futureItems = items.filter(
        (i) => (i.timeStart ?? '') >= todayStr && i.title !== routine.title && !overriddenDates.has((i.timeStart ?? '').slice(0, 10)),
    );
    if (!futureItems.length) {
        return [];
    }

    const ops = await Promise.all(
        futureItems.map(async (item) => {
            const itemId = item._id;
            if (!itemId) {
                return null;
            }
            const updated: ItemInterface = { ...item, title: routine.title, updatedTs: now };
            await itemsDAO.replaceById(itemId, updated);
            return recordOperation(userId, { entityType: 'item', entityId: itemId, snapshot: updated, opType: 'update', now });
        }),
    );
    return ops.filter((op): op is OperationInterface => op !== null);
}

/**
 * Regenerates future calendar items when the routine's schedule (rrule, timeOfDay, or duration)
 * changes at the GCal master level: trashes existing future items (so their IDs stay in the sync
 * log) and inserts fresh items on the new occurrence dates. Done + transformed items keep their
 * claim on the date so we don't produce duplicates alongside them.
 *
 * Trash-and-insert rather than in-place update because rrule changes can add/remove occurrences,
 * not just shift them. Doing it as two clean phases (trash existing, create new) avoids a fragile
 * per-date alignment and mirrors the client's `deleteAndRegenerateFutureItems`.
 */
export async function regenerateFutureRoutineItems(routine: RoutineInterface, userId: string, now: string, timeZone?: string): Promise<OperationInterface[]> {
    if (!routine.calendarItemTemplate) {
        return [];
    }
    // Paused routines: trash future items (if any) but never insert new ones. This preserves the
    // invariant that a paused routine has zero future open items, even if the caller forgot the check.
    const trashedOps = await trashExistingFutureItems(routine, userId, now);
    if (!routine.active) {
        return trashedOps;
    }
    const createdOps = await insertFreshFutureItems(routine, userId, now, timeZone);
    return [...trashedOps, ...createdOps];
}

/** Moves every future `calendar`-status item for this routine to `trash`, recording an op per item. */
async function trashExistingFutureItems(routine: RoutineInterface, userId: string, now: string): Promise<OperationInterface[]> {
    const todayStr = dayjs().startOf('day').format('YYYY-MM-DD');
    const future = await itemsDAO.findArray({ user: userId, routineId: routine._id, status: 'calendar', timeStart: { $gte: todayStr } });
    const futureIds = future.map((i) => i._id).filter((id): id is string => Boolean(id));
    if (!futureIds.length) {
        return [];
    }
    await itemsDAO.updateMany({ _id: { $in: futureIds }, user: userId } as never, { $set: { status: 'trash', updatedTs: now } });
    const ops = await Promise.all(
        future.map(async (item) => {
            const itemId = item._id;
            if (!itemId) {
                return null;
            }
            const snapshot: ItemInterface = { ...item, status: 'trash', updatedTs: now };
            return recordOperation(userId, { entityType: 'item', entityId: itemId, snapshot, opType: 'update', now });
        }),
    );
    return ops.filter((op): op is OperationInterface => op !== null);
}

/**
 * Inserts a fresh calendar item for each valid rrule occurrence in the horizon, skipping any
 * date that still has a non-trash item for this routine (e.g. a `done` or transformed-to-nextAction
 * item) so we never duplicate an occurrence the user has already disposed of or re-homed.
 */
async function insertFreshFutureItems(routine: RoutineInterface, userId: string, now: string, timeZone?: string): Promise<OperationInterface[]> {
    const claimedDates = await dateSetClaimedByNonTrashItems(routine._id, userId);
    const occurrences = getValidFutureOccurrences(routine).filter((d) => !claimedDates.has(d.toISOString().slice(0, 10)));
    const ops = await Promise.all(
        occurrences.map(async (date) => {
            const item = buildCalendarItem(userId, routine, date, now, timeZone);
            await itemsDAO.insertOne(item);
            if (!item._id) {
                return null;
            }
            return recordOperation(userId, { entityType: 'item', entityId: item._id, snapshot: item, opType: 'create', now });
        }),
    );
    return ops.filter((op): op is OperationInterface => op !== null);
}

/** Dates still held by non-trash items of this routine — mirrors the client horizon generator's dedup. */
async function dateSetClaimedByNonTrashItems(routineId: string, userId: string): Promise<Set<string>> {
    const surviving = await itemsDAO.findArray({ user: userId, routineId, status: { $ne: 'trash' } });
    return new Set(surviving.map((i) => (i.timeStart ?? '').slice(0, 10)).filter((d): d is string => Boolean(d)));
}
