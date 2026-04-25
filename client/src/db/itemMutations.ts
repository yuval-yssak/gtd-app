import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import type { EnergyLevel, MyDB, StoredItem, StoredRoutine } from '../types/MyDB';
import { deleteItemById, putItem } from './itemHelpers';
import { getRoutineById } from './routineHelpers';
import { createNextRoutineItem, isCalendarRoutineExhausted, RruleExhaustedError } from './routineItemHelpers';
import { updateRoutine } from './routineMutations';
import { queueSyncOp } from './syncHelpers';

function nowIso(): string {
    return dayjs().toISOString();
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
    await queueSyncOp(db, { opType: 'create', entityType: 'item', entityId: item._id, snapshot: item });
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
        ...rest
    } = item;
    const updated: StoredItem = { ...rest, status: 'nextAction', ...meta, updatedTs: nowIso() };
    await putItem(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated });
    return updated;
}

export interface CalendarMeta {
    timeStart: string;
    timeEnd: string;
    calendarSyncConfigId?: string;
    calendarIntegrationId?: string;
}

export async function clarifyToCalendar(db: IDBPDatabase<MyDB>, item: StoredItem, meta: CalendarMeta): Promise<StoredItem> {
    // Strip nextAction/waitingFor-specific fields and stale calendar IDs so meta can set fresh ones.
    const {
        workContextIds: _wc,
        energy: _e,
        time: _t,
        focus: _f,
        urgent: _u,
        waitingForPersonId: _wfp,
        ignoreBefore: _ib,
        calendarSyncConfigId: _csc,
        calendarIntegrationId: _ci,
        ...rest
    } = item;
    const updated: StoredItem = {
        ...rest,
        status: 'calendar',
        timeStart: meta.timeStart,
        timeEnd: meta.timeEnd,
        ...(meta.calendarSyncConfigId ? { calendarSyncConfigId: meta.calendarSyncConfigId } : {}),
        ...(meta.calendarIntegrationId ? { calendarIntegrationId: meta.calendarIntegrationId } : {}),
        updatedTs: nowIso(),
    };
    await putItem(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated });
    return updated;
}

export interface WaitingForMeta {
    waitingForPersonId: string;
    peopleIds?: string[];
    expectedBy?: string;
    ignoreBefore?: string;
}

export async function clarifyToWaitingFor(db: IDBPDatabase<MyDB>, item: StoredItem, meta: WaitingForMeta): Promise<StoredItem> {
    // Strip calendar/nextAction-specific fields that don't apply to waitingFor
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
        ...rest
    } = item;
    const updated: StoredItem = { ...rest, status: 'waitingFor', ...meta, updatedTs: nowIso() };
    await putItem(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated });
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
        ...rest
    } = item;
    const updated: StoredItem = { ...rest, status: 'inbox', updatedTs: nowIso() };
    await putItem(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated });
    return updated;
}

export async function clarifyToSomedayMaybe(db: IDBPDatabase<MyDB>, item: StoredItem): Promise<StoredItem> {
    // Someday/Maybe carries the same shape as inbox — no schedule, context, or waitingFor metadata.
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
        ...rest
    } = item;
    const updated: StoredItem = { ...rest, status: 'somedayMaybe', updatedTs: nowIso() };
    await putItem(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated });
    return updated;
}

export async function clarifyToDone(db: IDBPDatabase<MyDB>, item: StoredItem): Promise<StoredItem> {
    const updated: StoredItem = { ...item, status: 'done', updatedTs: nowIso() };
    await putItem(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated });
    await maybeCreateNextRoutineItem(db, item, 'done');
    return updated;
}

export async function clarifyToTrash(db: IDBPDatabase<MyDB>, item: StoredItem): Promise<StoredItem> {
    const updated: StoredItem = { ...item, status: 'trash', updatedTs: nowIso() };
    await putItem(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated });
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
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated });
    return updated;
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
    await deleteItemById(db, itemId);
    await queueSyncOp(db, { opType: 'delete', entityType: 'item', entityId: itemId, snapshot: null });
}
