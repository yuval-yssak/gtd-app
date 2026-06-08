import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import rrule from 'rrule';
import itemsDAO from '../dataAccess/itemsDAO.js';
import { GCAL_OWNED_ROUTINE_KEYS, type ItemInterface, type OperationInterface, type RoutineInterface } from '../types/entities.js';
import { isDuplicateKeyError } from './mongoErrors.js';
import { recordOperation } from './operationHelpers.js';
import { hasAtLeastOne } from './typeUtils.js';

/**
 * Extracts the GCal-owned slice (organizer/creator/attendees/responseStatus/eventType) from either
 * the routine master or a per-instance exception override. Per RFC 5545 each modified instance is
 * its own VEVENT carrying a full attendee list — but only the keys that diverged from the master
 * are persisted on the exception entry. Callers merge override-over-master so per-key inheritance
 * is preserved: missing key on the override ⇒ inherit master, present key ⇒ override wins.
 */
function pickGCalOwnedRoutineMirror(
    source: Partial<Pick<RoutineInterface, (typeof GCAL_OWNED_ROUTINE_KEYS)[number]>>,
): Partial<Pick<ItemInterface, (typeof GCAL_OWNED_ROUTINE_KEYS)[number]>> {
    const next: Partial<Pick<ItemInterface, (typeof GCAL_OWNED_ROUTINE_KEYS)[number]>> = {};
    for (const key of GCAL_OWNED_ROUTINE_KEYS) {
        const value = source[key];
        if (value !== undefined) {
            // Both routine + exception entry use the same field shape as ItemInterface for these keys
            // (same `GCalPerson`/`GCalAttendee` types from entities.ts), so the assignment is shape-safe.
            (next as Record<string, unknown>)[key] = value;
        }
    }
    return next;
}

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

/**
 * True iff the master rrule (anchored exactly as `getValidFutureOccurrences` anchors it) still
 * generates an occurrence on `date` (a `YYYY-MM-DD`). Deliberately ignores `routineExceptions` —
 * the caller (skipped-exception revival) is reconciling a `skipped` exception away and needs the
 * RAW rrule truth, not the exception-filtered set. RRule's own UNTIL/COUNT handling means a series
 * capped by a past UNTIL (e.g. a paused routine) correctly reports no occurrence, so we never
 * resurrect an occurrence the live recurrence no longer produces.
 *
 * Queries a ±1-day window so a `between` boundary can't drop an occurrence whose UTC-midnight
 * anchor lands on the adjacent calendar day; the `.some` narrows back to the exact date.
 */
export function routineGeneratesOccurrenceOnDate(routine: RoutineInterface, date: string): boolean {
    const anchorTs = routine.startDate ?? routine.createdTs;
    const rule = buildCalendarRule(routine.rrule, dayjs.utc(anchorTs.slice(0, 10)).toDate());
    const windowStart = dayjs.utc(date).subtract(1, 'day').toDate();
    const windowEnd = dayjs.utc(date).add(1, 'day').toDate();
    return rule.between(windowStart, windowEnd, true).some((d) => d.toISOString().slice(0, 10) === date);
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
 * Strip the recurrence-anchor suffix from a GCal recurring-master event id. Google sometimes
 * returns rebased masters (after a "this and following" split done in GCal) with ids of the form
 * `<masterId>_R<YYYYMMDDTHHMMSS>Z?` (timed) or `<masterId>_R<YYYYMMDD>` (all-day). Storing the
 * suffixed form as `routine.calendarEventId` breaks two things:
 *  1. `buildCalendarInstanceEventId` concatenates a `_<utc>Z` instance suffix and produces a
 *     double-anchored id that no GCal payload ever matches → reconcile orphan-creates duplicates.
 *  2. The `recurringEventId` filter that hides series instances (calendar.ts) compares against the
 *     stored `calendarEventId` set; if storage is suffixed but GCal's `recurringEventId` is the
 *     bare master id, the filter misses and instances surface as standalone items.
 *
 * Idempotent: a bare master id passes through unchanged. Exported for unit testing.
 */
export function normalizeMasterEventId(id: string): string {
    return id.replace(/_R\d{8}(T\d{6}Z?)?$/, '');
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
    // Per RFC 5545: per-instance override wins per-key over the master attendee list. Master mirror
    // first; exception keys (if any) overlay on top. Both are pulled through `pickGCalOwnedRoutineMirror`
    // so undefined keys never reach the spread (preserves exactOptionalPropertyTypes).
    const masterGCalOwned = pickGCalOwnedRoutineMirror(routine);
    const overrideGCalOwned = contentException ? pickGCalOwnedRoutineMirror(contentException) : {};
    const gcalOwned = { ...masterGCalOwned, ...overrideGCalOwned };

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
        ...gcalOwned,
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
 * Reconciles future calendar items to the routine's current schedule (rrule, timeOfDay, duration),
 * emitting only the DELTA: trashes future live items whose occurrence date the schedule no longer
 * produces (or whose timing/title drifted), and inserts items for newly-required dates. Done +
 * transformed items keep their claim on a date so we never duplicate one the user already disposed of.
 *
 * Idempotent by design: when the schedule is unchanged, every required date is already covered by a
 * matching live item and no date is orphaned → zero ops. This is the load-bearing property. A naive
 * trash-all-then-recreate (the prior implementation) made an unchanged GCal re-report rewrite the
 * whole instance set every webhook fire — e.g. a self-referential "this and following" split that
 * oscillates its rrule churned 45 items into 45 trash + 45 fresh rows on each sync.
 */
export async function regenerateFutureRoutineItems(routine: RoutineInterface, userId: string, now: string, timeZone?: string): Promise<OperationInterface[]> {
    if (!routine.calendarItemTemplate) {
        return [];
    }
    const liveByDate = await futureLiveItemsByDate(routine, userId);
    // Paused routines hold zero future open items: every live item is an orphan, nothing is required.
    const required = routine.active ? await requiredDatesNotAlreadyClaimed(routine, userId) : new Set<string>();
    const trashedOps = await trashOrphanedItems(routine, userId, now, liveByDate, required);
    const createdOps = await createMissingOccurrences(routine, userId, now, timeZone, liveByDate, required);
    return [...trashedOps, ...createdOps];
}

/** Future `calendar`-status items for the routine, indexed by their `YYYY-MM-DD` occurrence date. */
async function futureLiveItemsByDate(routine: RoutineInterface, userId: string): Promise<Map<string, ItemInterface>> {
    const todayStr = dayjs().startOf('day').format('YYYY-MM-DD');
    const future = await itemsDAO.findArray({ user: userId, routineId: routine._id, status: 'calendar', timeStart: { $gte: todayStr } });
    return new Map(future.map((item) => [(item.timeStart ?? '').slice(0, 10), item]));
}

/**
 * Dates the routine must cover now, minus dates one of its own DISPOSED items already holds: a
 * `done`/transformed item the user disposed of keeps its claim forever, so creation must skip it. This
 * routine's OWN live calendar items are deliberately NOT a veto — they're the keep/drift candidates
 * handled downstream. Building the claim set by QUERY exclusion (rather than deleting every `liveByDate`
 * date from an all-items set afterward) is essential: a date carrying BOTH a live item and a coexisting
 * `done` item must stay vetoed, else a drifted live row would spawn a duplicate beside the done one.
 * Cross-routine collisions are not handled here — the `(user, calendarInstanceEventId)` unique index
 * plus `insertFreshOccurrence`'s duplicate-key swallow own that case.
 */
async function requiredDatesNotAlreadyClaimed(routine: RoutineInterface, userId: string): Promise<Set<string>> {
    const claimed = await dateSetClaimedByDisposedItems(routine._id, userId);
    return new Set(
        getValidFutureOccurrences(routine)
            .map((d) => d.toISOString().slice(0, 10))
            .filter((date) => !claimed.has(date)),
    );
}

/** Moves every future `calendar`-status item for this routine to `trash`, recording an op per item. */
/**
 * Trashes only the live items the current schedule no longer wants: a date the rrule no longer
 * produces, or one whose timing/title drifted from what the routine would now generate (so the stale
 * row is replaced by a fresh one in `createMissingOccurrences`). A live item matching its required
 * date is left untouched — this is what makes an unchanged re-report a no-op.
 */
async function trashOrphanedItems(
    routine: RoutineInterface,
    userId: string,
    now: string,
    liveByDate: Map<string, ItemInterface>,
    required: Set<string>,
): Promise<OperationInterface[]> {
    const orphans = [...liveByDate].filter(([date, item]) => !required.has(date) || itemDriftsFromSchedule(item, routine, now)).map(([, item]) => item);
    if (!hasAtLeastOne(orphans)) {
        return [];
    }
    const orphanIds = orphans.map((i) => i._id).filter((id): id is string => Boolean(id));
    // Free `calendarInstanceEventId` on trash. The `(user, calendarInstanceEventId)` unique index is
    // partial on the field's PRESENCE (not status), so a trashed item keeps reserving its instance id —
    // which then E11000-blocks a replacement routine (e.g. a "this and following" split successor, or a
    // disconnect→reconnect re-import) from regenerating that same occurrence. Clearing it here releases
    // the id so the live routine can claim it. `insertFreshOccurrence` swallows the collision silently,
    // so without this the occurrence would vanish from the app with no error.
    await itemsDAO.updateMany({ _id: { $in: orphanIds }, user: userId } as never, {
        $set: { status: 'trash', updatedTs: now },
        $unset: { calendarInstanceEventId: '' },
    });
    const ops = await Promise.all(
        orphans.map(async (item) => {
            const itemId = item._id;
            if (!itemId) {
                return null;
            }
            // Drop calendarInstanceEventId from the op snapshot too so other devices converge to the
            // freed state and don't keep the id reserved locally.
            const { calendarInstanceEventId: _freed, ...rest } = item;
            const snapshot: ItemInterface = { ...rest, status: 'trash', updatedTs: now };
            return recordOperation(userId, { entityType: 'item', entityId: itemId, snapshot, opType: 'update', now });
        }),
    );
    return ops.filter((op): op is OperationInterface => op !== null);
}

/**
 * True when a live item no longer reflects the routine's current generation for its date — its
 * start/end timing or title drifted (e.g. GCal moved the master time, renamed the series, or changed
 * duration). Timing/title are the only fields a schedule change can move; comparing them avoids
 * trashing a still-correct item (which would defeat idempotency) while still replacing a stale one.
 */
function itemDriftsFromSchedule(item: ItemInterface, routine: RoutineInterface, now: string): boolean {
    const date = (item.timeStart ?? '').slice(0, 10);
    const desired = buildCalendarItem(item.user, routine, dayjs.utc(date).toDate(), now);
    return item.timeStart !== desired.timeStart || item.timeEnd !== desired.timeEnd || item.title !== desired.title;
}

/**
 * Inserts a fresh calendar item for each required date not already covered by a surviving live item.
 * `required` has already excluded dates held by a disposed item of this routine (done/transformed), so
 * we never duplicate an occurrence the user has already completed or re-homed.
 */
async function createMissingOccurrences(
    routine: RoutineInterface,
    userId: string,
    now: string,
    timeZone: string | undefined,
    liveByDate: Map<string, ItemInterface>,
    required: Set<string>,
): Promise<OperationInterface[]> {
    // A live item survives (is not recreated) only when its date is required AND it didn't drift —
    // mirror that exact predicate so a drifted item, just trashed above, gets a fresh replacement.
    const survivingDates = new Set(
        [...liveByDate].filter(([date, item]) => required.has(date) && !itemDriftsFromSchedule(item, routine, now)).map(([date]) => date),
    );
    const missing = [...required].filter((date) => !survivingDates.has(date)).map((date) => dayjs.utc(date).toDate());
    const ops = await Promise.all(missing.map((date) => insertFreshOccurrence(routine, userId, now, date, timeZone)));
    return ops.filter((op): op is OperationInterface => op !== null);
}

/**
 * Inserts a single occurrence's calendar item, returning its create op. A duplicate-key collision on
 * the `(user, calendarInstanceEventId)` index — which happens when a sibling routine bound to the SAME
 * GCal series already owns this instance date — is swallowed (logged, skipped) so one stray duplicate
 * can never reject the whole regeneration and throw the webhook sync. The other occurrences still insert.
 */
async function insertFreshOccurrence(
    routine: RoutineInterface,
    userId: string,
    now: string,
    date: Date,
    timeZone?: string,
): Promise<OperationInterface | null> {
    const item = buildCalendarItem(userId, routine, date, now, timeZone);
    try {
        await itemsDAO.insertOne(item);
    } catch (err) {
        if (isDuplicateKeyError(err)) {
            console.warn(
                `[routine] skipped duplicate instance — already owned by a sibling on this GCal series | routineId=${routine._id} calendarInstanceEventId=${item.calendarInstanceEventId} date=${date.toISOString().slice(0, 10)}`,
            );
            return null;
        }
        throw err;
    }
    if (!item._id) {
        return null;
    }
    return recordOperation(userId, { entityType: 'item', entityId: item._id, snapshot: item, opType: 'create', now });
}

/**
 * Dates held by this routine's DISPOSED items — `done` or transformed-to-nextAction/etc. (any non-trash
 * status that is NOT a live `calendar` item). These keep their date claim forever so we never recreate an
 * occurrence the user already completed or re-homed. This routine's own live `calendar` items are excluded
 * on purpose — they are the keep/drift candidates the reconcile handles directly, not a creation veto.
 * Excluding them at the QUERY level (rather than deleting their dates afterward) is what preserves the
 * claim of a `done` item that shares a date with a live one: the live row's presence can't unmask it.
 * Scoped to this routine only; cross-routine date collisions are the instance-id index's responsibility.
 */
async function dateSetClaimedByDisposedItems(routineId: string, userId: string): Promise<Set<string>> {
    const disposed = await itemsDAO.findArray({ user: userId, routineId, status: { $nin: ['trash', 'calendar'] } });
    return new Set(disposed.map((i) => (i.timeStart ?? '').slice(0, 10)).filter((d): d is string => Boolean(d)));
}
