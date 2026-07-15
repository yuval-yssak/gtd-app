import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { recordGhostSnapshot } from '../lib/listGhosts';
import type { EnergyLevel, MyDB, StoredItem, StoredRoutine } from '../types/MyDB';
import { deleteItemById, putItem } from './itemHelpers';
import { getRoutineById } from './routineHelpers';
import { createNextRoutineItem, isCalendarRoutineExhausted, RruleExhaustedError } from './routineItemHelpers';
import { updateRoutine } from './routineMutations';
import { queueSyncOp } from './syncHelpers';

function nowIso(): string {
    return dayjs().toISOString();
}

/**
 * Snackbar text shown when a user transitions a `fromGmail` calendar item to a status the server
 * would normally push to GCal (e.g. `done`). Google's Calendar API treats fromGmail events as
 * read-only — the GTD-side change persists, but the server skips pushback. Surfaced as a single
 * shared constant so every done-transition surface emits identical wording.
 */
export const FROM_GMAIL_READONLY_MESSAGE = 'GCal events from Gmail can only be edited in Gmail.';

/**
 * A status change removes the item from the list it was on; the pre-mutation snapshot
 * lets that list briefly render a fading "ghost" of the row (see useListGhosts).
 * Only user-initiated local mutations pass through here — sync-applied ops from other
 * devices go through syncHelpers and intentionally never record ghosts.
 */
function recordGhostIfLeavingList(previous: StoredItem, updated: StoredItem): void {
    if (previous.status !== updated.status) {
        recordGhostSnapshot(previous);
    }
}

function buildBaseItem(userId: string, title: string): StoredItem {
    const now = nowIso();
    return {
        _id: crypto.randomUUID(),
        userId,
        status: 'inbox',
        title,
        createdTs: now,
        updatedTs: now,
    };
}

// ── Collect ───────────────────────────────────────────────────────────────────

export async function collectItem(db: IDBPDatabase<MyDB>, userId: string, { title, notes }: { title: string; notes?: string }): Promise<StoredItem> {
    const base = buildBaseItem(userId, title);
    // exactOptionalPropertyTypes: omit key rather than assigning undefined
    const item = notes?.trim() ? { ...base, notes: notes.trim() } : base;
    await putItem(db, item);
    await queueSyncOp(db, { opType: 'create', entityType: 'item', entityId: item._id, snapshot: item, userId: item.userId });
    return item;
}

// ── Clarify ───────────────────────────────────────────────────────────────────

export interface NextActionMeta {
    workContextIds?: string[];
    peopleIds?: string[];
    energy?: EnergyLevel;
    time?: number;
    focus?: boolean;
    urgent?: boolean;
    expectedBy?: string;
    ignoreBefore?: string;
}

export async function clarifyToNextAction(db: IDBPDatabase<MyDB>, item: StoredItem, meta: NextActionMeta = {}): Promise<StoredItem> {
    // Strip calendar/waitingFor-specific fields that don't apply to nextAction
    const {
        timeStart: _ts,
        timeEnd: _te,
        calendarEventId: _ce,
        calendarIntegrationId: _ci,
        calendarSyncConfigId: _csc,
        waitingForPersonId: _wfp,
        allDay: _ad,
        ...rest
    } = item;
    const updated: StoredItem = { ...rest, status: 'nextAction', ...meta, updatedTs: nowIso() };
    recordGhostIfLeavingList(item, updated);
    await putItem(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated, userId: updated.userId });
    return updated;
}

export interface CalendarMeta {
    timeStart: string;
    timeEnd: string;
    calendarSyncConfigId?: string;
    calendarIntegrationId?: string;
    /** True when timeStart/timeEnd are date-only YYYY-MM-DD strings (GCal exclusive-end preserved). */
    allDay?: boolean;
}

export async function clarifyToCalendar(db: IDBPDatabase<MyDB>, item: StoredItem, meta: CalendarMeta): Promise<StoredItem> {
    // Strip nextAction/waitingFor-specific fields and stale calendar IDs so meta can set fresh ones.
    // Also strip `allDay` so the meta's value (true OR omitted) wins — leaving a stale `true`
    // on a now-timed event would corrupt GCal pushback (it would emit { date } against an ISO timeStart).
    const {
        workContextIds: _wc,
        energy: _e,
        time: _t,
        focus: _f,
        urgent: _u,
        waitingForPersonId: _wfp,
        // expectedBy is not allowed on calendar items — leaving it on the snapshot makes
        // /sync/push 400 (status_field_violation) and permanently jams the device's sync queue.
        expectedBy: _eb,
        ignoreBefore: _ib,
        calendarSyncConfigId: _csc,
        calendarIntegrationId: _ci,
        allDay: _ad,
        ...rest
    } = item;
    const updated: StoredItem = {
        ...rest,
        status: 'calendar',
        timeStart: meta.timeStart,
        timeEnd: meta.timeEnd,
        ...(meta.calendarSyncConfigId ? { calendarSyncConfigId: meta.calendarSyncConfigId } : {}),
        ...(meta.calendarIntegrationId ? { calendarIntegrationId: meta.calendarIntegrationId } : {}),
        ...(meta.allDay ? { allDay: true } : {}),
        updatedTs: nowIso(),
    };
    recordGhostIfLeavingList(item, updated);
    await putItem(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated, userId: updated.userId });
    return updated;
}

export interface WaitingForMeta {
    // Optional — a waitingFor item need not name a person (e.g. blocked on a delivery, not someone).
    waitingForPersonId?: string;
    peopleIds?: string[];
    expectedBy?: string;
    ignoreBefore?: string;
}

export async function clarifyToWaitingFor(db: IDBPDatabase<MyDB>, item: StoredItem, meta: WaitingForMeta): Promise<StoredItem> {
    // Strip calendar/nextAction-specific fields that don't apply to waitingFor. Also drop any
    // pre-existing waitingForPersonId — meta carries it only when set, so spreading `...meta`
    // over a stripped base means clearing the person (meta omits the key) actually unsets it.
    const {
        timeStart: _ts,
        timeEnd: _te,
        calendarEventId: _ce,
        calendarIntegrationId: _ci,
        calendarSyncConfigId: _csc,
        workContextIds: _wc,
        energy: _e,
        time: _t,
        focus: _f,
        urgent: _u,
        allDay: _ad,
        waitingForPersonId: _wfp,
        ...rest
    } = item;
    const updated: StoredItem = { ...rest, status: 'waitingFor', ...meta, updatedTs: nowIso() };
    recordGhostIfLeavingList(item, updated);
    await putItem(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated, userId: updated.userId });
    return updated;
}

export async function clarifyToInbox(db: IDBPDatabase<MyDB>, item: StoredItem): Promise<StoredItem> {
    // Strip all status-specific fields — inbox items carry only title, notes, peopleIds, and routineId
    const {
        workContextIds: _wc,
        energy: _e,
        time: _t,
        focus: _f,
        urgent: _u,
        expectedBy: _eb,
        ignoreBefore: _ib,
        timeStart: _ts,
        timeEnd: _te,
        calendarEventId: _ce,
        calendarIntegrationId: _ci,
        calendarSyncConfigId: _csc,
        waitingForPersonId: _wfp,
        allDay: _ad,
        ...rest
    } = item;
    const updated: StoredItem = { ...rest, status: 'inbox', updatedTs: nowIso() };
    recordGhostIfLeavingList(item, updated);
    await putItem(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated, userId: updated.userId });
    return updated;
}

// Someday/Maybe carries only the two deferral dates — no schedule, context, or person metadata.
export interface SomedayMaybeMeta {
    expectedBy?: string;
    ignoreBefore?: string;
}

export async function clarifyToSomedayMaybe(db: IDBPDatabase<MyDB>, item: StoredItem, meta: SomedayMaybeMeta = {}): Promise<StoredItem> {
    // Strip every status-specific field (including expectedBy/ignoreBefore) off the base, then
    // re-apply the two deferral dates from meta — so an unset date in the form actually clears it.
    const {
        workContextIds: _wc,
        energy: _e,
        time: _t,
        focus: _f,
        urgent: _u,
        expectedBy: _eb,
        ignoreBefore: _ib,
        timeStart: _ts,
        timeEnd: _te,
        calendarEventId: _ce,
        calendarIntegrationId: _ci,
        calendarSyncConfigId: _csc,
        waitingForPersonId: _wfp,
        allDay: _ad,
        ...rest
    } = item;
    const updated: StoredItem = { ...rest, status: 'somedayMaybe', ...meta, updatedTs: nowIso() };
    recordGhostIfLeavingList(item, updated);
    await putItem(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated, userId: updated.userId });
    return updated;
}

/**
 * `clarifyToDone` accepts an optional `onReadOnlyGCal` callback — fired AFTER the local write
 * persists, when the server would normally try to push this transition to a GCal event the API
 * treats as read-only (`eventType: 'fromGmail'` events Google auto-creates from email attachments).
 * Gated on `calendarEventId` so the warning only fires for items that actually have a GCal-side
 * representation; otherwise the user would see a "can't edit in Gmail" warning for an item that
 * was never linked to GCal in the first place.
 *
 * Callers wire it to their Snackbar surface so the user learns "this won't sync to GCal" the moment
 * they click done, instead of the GCal-side change silently failing. The mutation itself proceeds
 * regardless — only GCal pushback is skipped server-side; the GTD state still flips to done.
 */
export async function clarifyToDone(db: IDBPDatabase<MyDB>, item: StoredItem, opts?: { onReadOnlyGCal?: () => void }): Promise<StoredItem> {
    const updated: StoredItem = { ...item, status: 'done', updatedTs: nowIso() };
    recordGhostIfLeavingList(item, updated);
    await putItem(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated, userId: updated.userId });
    await maybeCreateNextRoutineItem(db, item, 'done');
    if (item.eventType === 'fromGmail' && item.calendarEventId && opts?.onReadOnlyGCal) {
        opts.onReadOnlyGCal();
    }
    return updated;
}

export async function clarifyToTrash(db: IDBPDatabase<MyDB>, item: StoredItem): Promise<StoredItem> {
    const updated: StoredItem = { ...item, status: 'trash', updatedTs: nowIso() };
    recordGhostIfLeavingList(item, updated);
    await putItem(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated, userId: updated.userId });
    await maybeCreateNextRoutineItem(db, item, 'trash');
    return updated;
}

/**
 * If the item belongs to an active routine, create the next scheduled item.
 * Triggered on done/trash regardless of the item's current status so the routine continues
 * even when the item was transformed (e.g. inbox → done) before being completed.
 * RruleExhaustedError means the series is over — deactivate the routine rather than log an error.
 * Other errors are caught and logged so a failed next-item creation never hides a successful status change.
 */
async function maybeCreateNextRoutineItem(db: IDBPDatabase<MyDB>, item: StoredItem, disposalKind: 'done' | 'trash'): Promise<void> {
    if (!item.routineId) {
        return;
    }
    const routine = await getRoutineById(db, item.routineId);
    if (!routine?.active) {
        return;
    }

    try {
        if (routine.routineType === 'nextAction') {
            await createNextRoutineItem(db, item.userId, routine, dayjs().toDate());
        } else {
            await createNextCalendarRoutineItem(db, item, routine, disposalKind);
        }
    } catch (err) {
        if (err instanceof RruleExhaustedError) {
            // Series is complete — mark the routine inactive so it stops generating items
            await updateRoutine(db, { ...routine, active: false });
        } else {
            console.error('[routine] failed to create next item:', err);
        }
    }
}

/** Add a 'skipped' exception for `date` to the routine, if not already present. Returns updated routine. */
async function addCalendarException(db: IDBPDatabase<MyDB>, routine: StoredRoutine, date: string): Promise<StoredRoutine> {
    const existing = routine.routineExceptions ?? [];
    if (existing.some((e) => e.date === date)) {
        return routine;
    }
    return updateRoutine(db, { ...routine, routineExceptions: [...existing, { date, type: 'skipped' as const }] });
}

/**
 * Handle next-item generation for calendar routines.
 * Before-due trash: record a skipped exception so the date is not regenerated.
 * Disposal never extends the horizon — the initial horizon pass at routine creation (and any
 * subsequent rrule-edit/split regen) is the sole generator. Tying regen to disposal caused the
 * matrix-A8 phantom duplicate when a race around the disposal wrote today's regenerated `calendar`
 * item before the `done` item was visible to the dedupe filter. Horizon rollover over calendar
 * time is a separate concern handled by the split/rrule-edit paths, not by dispose.
 * After recording the exception (if any), if the series has no live items left and no future
 * rrule occurrences, deactivate the routine — covers `COUNT=1` one-shots and otherwise-consumed
 * series so they don't linger as active rows on the Routines page.
 */
async function createNextCalendarRoutineItem(db: IDBPDatabase<MyDB>, item: StoredItem, routine: StoredRoutine, disposalKind: 'done' | 'trash'): Promise<void> {
    const { timeStart } = item;
    const effectiveRoutine =
        disposalKind === 'trash' && timeStart !== undefined && dayjs().isBefore(dayjs(timeStart))
            ? await addCalendarException(db, routine, dayjs(timeStart).format('YYYY-MM-DD'))
            : routine;
    if (await isCalendarRoutineExhausted(db, item.userId, effectiveRoutine)) {
        await updateRoutine(db, { ...effectiveRoutine, active: false });
    }
}

// ── Generic edit ──────────────────────────────────────────────────────────────

export async function updateItem(db: IDBPDatabase<MyDB>, item: StoredItem): Promise<StoredItem> {
    const updated: StoredItem = { ...item, updatedTs: nowIso() };
    await putItem(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated, userId: updated.userId });
    return updated;
}

/**
 * Variant of `updateItem` that forwards an organizer-notification decision (captured by the
 * SendUpdatesDialog) to the queued sync op. The sidecar rides the op through the offline queue so
 * the choice survives reconnect — `gcalMeta.sendUpdates` is read by the server-side pushback that
 * eventually calls the GCal `events.patch` API.
 */
export async function updateItemWithGcalMeta(db: IDBPDatabase<MyDB>, item: StoredItem, gcalMeta: { sendUpdates: 'all' | 'none' }): Promise<StoredItem> {
    const updated: StoredItem = { ...item, updatedTs: nowIso() };
    await putItem(db, updated);
    await queueSyncOp(db, {
        opType: 'update',
        entityType: 'item',
        entityId: updated._id,
        snapshot: updated,
        userId: updated.userId,
        gcalMeta,
    });
    return updated;
}

/**
 * Updates the attendees array on a calendar item — used by the meeting-details attendee editor.
 * Queues an `update` op so the new list propagates through the normal sync path; the server's
 * pushback turns this into an `events.patch` against GCal with the captured `sendUpdates` choice
 * (omitted here, defaults handled server-side).
 */
export async function updateItemAttendees(db: IDBPDatabase<MyDB>, item: StoredItem, attendees: StoredItem['attendees']): Promise<StoredItem> {
    const next: StoredItem = attendees && attendees.length > 0 ? { ...item, attendees, updatedTs: nowIso() } : stripAttendees({ ...item, updatedTs: nowIso() });
    await putItem(db, next);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: next._id, snapshot: next, userId: next.userId });
    return next;
}

/** Removes the attendees key entirely so an empty edit doesn't leave an empty array on the item. */
function stripAttendees(item: StoredItem): StoredItem {
    const { attendees: _a, ...rest } = item;
    return rest;
}

/**
 * Records an offline RSVP. Used as the fallback when the online `/calendar/items/:id/rsvp` POST
 * couldn't reach the server. Writes the optimistic responseStatus + attendees to IDB and queues
 * an `opType: 'rsvp'` op carrying the structured payload — the server's replay path performs the
 * GCal PATCH on the next flush.
 */
export async function queueOfflineRsvp(
    db: IDBPDatabase<MyDB>,
    item: StoredItem,
    rsvp: {
        responseStatus: 'accepted' | 'declined' | 'tentative';
        calendarEventId: string;
        calendarIntegrationId: string;
        attendees: StoredItem['attendees'];
    },
): Promise<StoredItem> {
    const next: StoredItem = {
        ...item,
        responseStatus: rsvp.responseStatus,
        ...(rsvp.attendees ? { attendees: rsvp.attendees } : {}),
        updatedTs: nowIso(),
    };
    await putItem(db, next);
    await queueSyncOp(db, {
        opType: 'rsvp',
        entityType: 'item',
        entityId: item._id,
        snapshot: null,
        userId: item.userId,
        rsvp: {
            itemId: item._id,
            calendarEventId: rsvp.calendarEventId,
            calendarIntegrationId: rsvp.calendarIntegrationId,
            responseStatus: rsvp.responseStatus,
        },
    });
    return next;
}

/**
 * Records a `modified` exception on the routine for the given occurrence date so future
 * series regeneration keeps the override. Idempotent — re-recording on the same date updates
 * the exception in place rather than appending duplicates.
 * `originalDate` is the ISO date of the occurrence the item was generated for — typically
 * dayjs(item.timeStart).format('YYYY-MM-DD') _before_ the user's time edit.
 */
export async function recordRoutineInstanceModification(
    db: IDBPDatabase<MyDB>,
    routineId: string,
    originalDate: string,
    override: { itemId: string; newTimeStart?: string; newTimeEnd?: string; title?: string; notes?: string },
): Promise<void> {
    const routine = await getRoutineById(db, routineId);
    if (!routine) {
        return;
    }
    const existing = routine.routineExceptions ?? [];
    const filtered = existing.filter((e) => e.date !== originalDate);
    // Explicit-omission pattern (matches clarify helpers) — exactOptionalPropertyTypes disallows undefined assignment.
    const entry = {
        date: originalDate,
        type: 'modified' as const,
        itemId: override.itemId,
        ...(override.newTimeStart ? { newTimeStart: override.newTimeStart } : {}),
        ...(override.newTimeEnd ? { newTimeEnd: override.newTimeEnd } : {}),
        ...(override.title ? { title: override.title } : {}),
        ...(override.notes ? { notes: override.notes } : {}),
    };
    await updateRoutine(db, { ...routine, routineExceptions: [...filtered, entry] });
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function removeItem(db: IDBPDatabase<MyDB>, itemId: string): Promise<void> {
    // Read the owning userId before delete so the queued op is scoped to the right account.
    // Falling back to the active account (queueSyncOp's default) is wrong when the deleted
    // item belongs to a non-active session (unified-view world).
    const existing = await db.get('items', itemId);
    // Hard deletes leave a list too — record the ghost so the row fades out in place.
    if (existing) {
        recordGhostSnapshot(existing);
    }
    await deleteItemById(db, itemId);
    await queueSyncOp(db, {
        opType: 'delete',
        entityType: 'item',
        entityId: itemId,
        snapshot: null,
        ...(existing?.userId ? { userId: existing.userId } : {}),
    });
}
