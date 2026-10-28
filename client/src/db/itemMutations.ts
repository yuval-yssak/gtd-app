import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { compareByRank } from '../lib/compareNextActions';
import { compareRank, evenlySpacedRanks, isRankTooLong, rankAt, rankBetween, ranksBetween } from '../lib/itemRank';
import { recordGhostSnapshot } from '../lib/listGhosts';
import { rankSectionKeyOf } from '../lib/rankSections';
import type { EnergyLevel, MyDB, StoredItem, StoredRoutine } from '../types/MyDB';
import { ROUTINE_ITEMS_LOCK, withCrossContextLock } from './crossContextLock';
import { deleteItemById, getItemsAcrossUsers, putItem, topRankForUser } from './itemHelpers';
import { getRoutineById } from './routineHelpers';
import { createNextRoutineItem, isCalendarRoutineExhausted, RruleExhaustedError } from './routineItemHelpers';
import { updateRoutine } from './routineMutations';
import { queueDeleteThenRemove, queueSyncOp } from './syncHelpers';

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
    // Every new item is minted a priority key above the user's existing ones (StoredItem.rank).
    const base = { ...buildBaseItem(userId, title), rank: await topRankForUser(db, userId) };
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
        // Only a done row holds a completion record (`withCompletionRecord`).
        statusBeforeDone: _sbd,
        ...rest
    } = item;
    // Clarifying an inbox capture is when the item becomes actionable, so it is minted a FRESH key
    // at the top of its section (its collect-time key may be a week old). Any other transition into
    // Next Actions (calendar detach, a revive from done) keeps its place; an item without a key
    // (born before the rollout, or through a path that does not mint) gets one. Mirrors the server's
    // `withRankOnEnteringNextAction`.
    const rank = item.status === 'inbox' || item.rank === undefined ? await topRankForUser(db, item.userId) : item.rank;
    const updated: StoredItem = { ...rest, status: 'nextAction', ...meta, rank, updatedTs: nowIso() };
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
        urgent: _u,
        waitingForPersonId: _wfp,
        // expectedBy is not allowed on calendar items — leaving it on the snapshot makes
        // /sync/push 400 (status_field_violation) and permanently jams the device's sync queue.
        expectedBy: _eb,
        ignoreBefore: _ib,
        calendarSyncConfigId: _csc,
        calendarIntegrationId: _ci,
        allDay: _ad,
        // Only a done row holds a completion record (`withCompletionRecord`).
        statusBeforeDone: _sbd,
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
        urgent: _u,
        allDay: _ad,
        waitingForPersonId: _wfp,
        // Only a done row holds a completion record (`withCompletionRecord`).
        statusBeforeDone: _sbd,
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
        // Only a done row holds a completion record (`withCompletionRecord`).
        statusBeforeDone: _sbd,
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
        // Only a done row holds a completion record (`withCompletionRecord`).
        statusBeforeDone: _sbd,
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
    const updated = await disposeItem(db, item, 'done');
    if (item.eventType === 'fromGmail' && item.calendarEventId && opts?.onReadOnlyGCal) {
        opts.onReadOnlyGCal();
    }
    return updated;
}

export async function clarifyToTrash(db: IDBPDatabase<MyDB>, item: StoredItem): Promise<StoredItem> {
    return disposeItem(db, item, 'trash');
}

/**
 * Writes a done/trash disposal and, for a routine item, its successor — under the routine-items lock,
 * so a materializer pass can never observe the gap between the two and mint a second open occurrence.
 */
async function disposeItem(db: IDBPDatabase<MyDB>, item: StoredItem, disposalKind: 'done' | 'trash'): Promise<StoredItem> {
    const updated: StoredItem = { ...withCompletionRecord(item, disposalKind), status: disposalKind, updatedTs: nowIso() };
    recordGhostIfLeavingList(item, updated);
    const writeDisposal = async () => {
        await putItem(db, updated);
        await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated, userId: updated.userId });
        await maybeCreateNextRoutineItem(db, item, disposalKind);
    };
    await (item.routineId ? withCrossContextLock(ROUTINE_ITEMS_LOCK, writeDisposal) : writeDisposal());
    return updated;
}

/**
 * The `statusBeforeDone` a disposal writes. Completing an open item records its status; trashing
 * one records nothing (it was never done) and sheds any stale value; an item already done or trash
 * keeps whatever it has. The server trusts a done snapshot's value — this queue may collapse several
 * transitions into one op — and applies the same rule otherwise (`api-server/src/lib/statusBeforeDone.ts`).
 */
function withCompletionRecord(item: StoredItem, disposalKind: 'done' | 'trash'): StoredItem {
    if (item.status === 'done' || item.status === 'trash') {
        return item;
    }
    if (disposalKind === 'done') {
        return { ...item, statusBeforeDone: item.status };
    }
    const { statusBeforeDone: _stale, ...withoutRecord } = item;
    return withoutRecord;
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

// ── Priority order (Next Actions drag and drop) ──────────────────────────────

/** A reorder as every gesture (drag, keyboard, Move to…) expresses it: the moved row and the VISIBLE rows it lands between. */
export interface ReorderRequest {
    /** The section's LIVE rows as displayed (filters applied, ghosts excluded — a ghost is a pre-mutation snapshot and must never be written back). */
    sectionItems: readonly StoredItem[];
    itemId: string;
    /** Ids of the visible neighbours the row lands between; either is absent at a section edge. Resolved against live rows, never by index. */
    aboveId?: string | undefined;
    belowId?: string | undefined;
    /**
     * Every account of the merged list, visible rows or not: an account whose rows in this day are
     * all filtered out still shares the keyspace, so a re-key must see them. Defaults to the owners
     * of the visible rows.
     */
    ownerIds?: readonly string[] | undefined;
}

/**
 * Re-keys `orderedItems` (rows of one day section in display order) with `keys`, one update op
 * per row. Every row gets a fresh `updatedTs`, so this can beat a concurrent offline edit of a
 * neighbour on another device under last-write-wins — accepted, and kept small: `ensureRunRanked`
 * re-keys only the non-increasing run around the drop, and the happy-path drag writes one row.
 */
async function rekeyRows(db: IDBPDatabase<MyDB>, orderedItems: readonly StoredItem[], keys: readonly string[]): Promise<StoredItem[]> {
    const now = nowIso();
    const rekeyed = orderedItems.map((item, idx) => ({ ...item, rank: rankAt(keys, idx), updatedTs: now }));
    for (const item of rekeyed) {
        await putItem(db, item);
        await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: item._id, snapshot: item, userId: item.userId });
    }
    return rekeyed;
}

/** Re-keys a whole section in its displayed order with fresh keys from the origin. */
export async function rebalanceSection(db: IDBPDatabase<MyDB>, orderedItems: readonly StoredItem[]): Promise<StoredItem[]> {
    return rekeyRows(db, orderedItems, evenlySpacedRanks(orderedItems.length));
}

/** True when a pair of neighbours can take a key between them: both missing (an empty section), one
 *  missing and the other ranked (a section edge), or both ranked and strictly ordered. */
function isOrderedPair(a: StoredItem | undefined, b: StoredItem | undefined): boolean {
    if (!a && !b) {
        return true;
    }
    if (!a || !b) {
        return (a ?? b)?.rank !== undefined;
    }
    return isRankedBelow(a, b);
}

function isRankedBelow(a: StoredItem | undefined, b: StoredItem | undefined): boolean {
    return a?.rank !== undefined && b?.rank !== undefined && compareRank(a.rank, b.rank) < 0;
}

/**
 * The minimal contiguous window of `rows` (display order) around `[from, to]` whose keys must be
 * re-minted. It grows outward while a boundary pair is unranked or not strictly increasing, then
 * trims back an edge row whose key already fits between the row outside the window and the rows
 * that will be re-minted inside it (its old key stays; one op fewer, one fewer chance to override
 * another device's edit). Keys from different accounts share no keyspace, so EQUAL keys across a
 * merged section are the normal case, not a corner one — re-keying only this run keeps a drop to
 * one or two ops instead of one per row of both accounts.
 */
export function nonIncreasingRun(rows: readonly StoredItem[], from: number, to: number): { lo: number; hi: number } {
    const ordered = (i: number) => isOrderedPair(rows[i], rows[i + 1]);
    const bounds = { lo: Math.max(Math.min(from, to), 0), hi: Math.min(Math.max(from, to), rows.length - 1) };
    while (bounds.lo > 0 && !ordered(bounds.lo - 1)) {
        bounds.lo -= 1;
    }
    while (bounds.hi < rows.length - 1 && !ordered(bounds.hi)) {
        bounds.hi += 1;
    }
    const last = rows.length - 1;
    const hiEdgeFits = () =>
        rows[bounds.hi]?.rank !== undefined &&
        (bounds.hi === last || isRankedBelow(rows[bounds.hi], rows[bounds.hi + 1])) &&
        (bounds.lo === 0 || isRankedBelow(rows[bounds.lo - 1], rows[bounds.hi]));
    const loEdgeFits = () =>
        rows[bounds.lo]?.rank !== undefined &&
        (bounds.lo === 0 || isRankedBelow(rows[bounds.lo - 1], rows[bounds.lo])) &&
        (bounds.hi === last || isRankedBelow(rows[bounds.lo], rows[bounds.hi + 1]));
    while (bounds.hi > bounds.lo && hiEdgeFits()) {
        bounds.hi -= 1;
    }
    while (bounds.lo < bounds.hi && loEdgeFits()) {
        bounds.lo += 1;
    }
    return bounds;
}

/** The run to re-key for a drop between `above` and `below` (either may be absent at a section edge). */
function runBounds(rows: readonly StoredItem[], above: StoredItem | undefined, below: StoredItem | undefined): { lo: number; hi: number } {
    const from = above ? rows.indexOf(above) : below ? rows.indexOf(below) : 0;
    const to = below ? rows.indexOf(below) : from;
    return nonIncreasingRun(rows, from, to);
}

/**
 * Guarantees `rankBetween` is never called with an unranked neighbour or with `above >= below`.
 * `rows` is the FULL day section minus the moved row, in display order (hidden rows included —
 * re-keying only the visible rows would scramble the hidden ones). Returns the rows by id after
 * any re-key; nothing is written when the two neighbours are already strictly ordered.
 */
export async function ensureRunRanked(
    db: IDBPDatabase<MyDB>,
    rows: readonly StoredItem[],
    neighbours: Pick<ReorderRequest, 'aboveId' | 'belowId'>,
): Promise<Map<string, StoredItem>> {
    const byId = new Map(rows.map((row) => [row._id, row]));
    const above = neighbours.aboveId === undefined ? undefined : byId.get(neighbours.aboveId);
    const below = neighbours.belowId === undefined ? undefined : byId.get(neighbours.belowId);
    if (isOrderedPair(above, below) || rows.length === 0) {
        return byId;
    }
    const { lo, hi } = runBounds(rows, above, below);
    const lower = rows[lo - 1]?.rank ?? null;
    const upper = rows[hi + 1]?.rank ?? null;
    // The run's bounds can still be inverted (keys are not monotone outside the run either) — then the whole section is re-keyed.
    const boundsOrdered = lower === null || upper === null || compareRank(lower, upper) < 0;
    const rekeyed = boundsOrdered ? await rekeyRows(db, rows.slice(lo, hi + 1), ranksBetween(lower, upper, hi - lo + 1)) : await rebalanceSection(db, rows);
    for (const row of rekeyed) {
        byId.set(row._id, row);
    }
    return byId;
}

/** The moved row AS STORED plus every other row of its rank section (`rankSectionKeyOf`) across the owners, in display order. */
interface RankSection {
    moved: StoredItem;
    others: StoredItem[];
}

/**
 * Reads the day section from IndexedDB — the source of truth. The moved row is taken from the
 * database too, never from the page's copy: a pull or another tab may have changed it since the
 * page rendered, and a write built from the rendered row would revert that edit under LWW. Hidden
 * rows (filters, search, the tickler, an account whose rows are all filtered out) are included on
 * purpose: they share the keyspace. Returns null when the moved row is gone or its status has no
 * manual order (it changed status mid-gesture to calendar, done or trash).
 */
async function readRankSection(db: IDBPDatabase<MyDB>, itemId: string, ownerIds: readonly string[]): Promise<RankSection | null> {
    const rows = await getItemsAcrossUsers(db, [...new Set(ownerIds)]);
    const moved = rows.find((row) => row._id === itemId);
    const sectionKey = moved ? rankSectionKeyOf(moved) : null;
    if (!moved || sectionKey === null) {
        return null;
    }
    const others = rows.filter((row) => row._id !== moved._id && rankSectionKeyOf(row) === sectionKey).sort(compareByRank);
    return { moved, others };
}

/**
 * True when the stored section still matches the one the gesture was planned against: the row is
 * on the same day it was rendered in (a pull may have re-dated it meanwhile — the neighbours would
 * then belong to another section), and at least one named neighbour still exists (both vanished
 * means the slot no longer exists; one vanished is a section edge).
 */
function isSameContext(section: RankSection, shown: StoredItem, neighbours: Pick<ReorderRequest, 'aboveId' | 'belowId'>): boolean {
    if (rankSectionKeyOf(section.moved) !== rankSectionKeyOf(shown)) {
        return false;
    }
    const named = [neighbours.aboveId, neighbours.belowId].filter((id): id is string => id !== undefined);
    return named.length === 0 || named.some((id) => section.others.some((row) => row._id === id));
}

/** True when the requested slot is where the row already sits — nothing to write. */
function isSamePlace(visible: readonly StoredItem[], moved: StoredItem, neighbours: Pick<ReorderRequest, 'aboveId' | 'belowId'>): boolean {
    const idx = visible.findIndex((row) => row._id === moved._id);
    return visible[idx - 1]?._id === neighbours.aboveId && visible[idx + 1]?._id === neighbours.belowId;
}

/**
 * Moves one row between two visible neighbours inside its rank section (`rankSectionKeyOf`: a Next
 * Actions or Waiting For day, the Inbox, Someday / Maybe) by writing ONE field on ONE row (one sync
 * op on the happy path). Never touches `expectedBy` or `status`: a drag changes only the order.
 * Returns the moved row, or null when nothing may be written: it already sits in the requested slot,
 * it vanished or its status changed mid-gesture, it moved to another section (re-dated elsewhere —
 * its neighbours belong to another section), or both named neighbours are gone.
 */
export async function reorderItem(db: IDBPDatabase<MyDB>, request: ReorderRequest): Promise<StoredItem | null> {
    const shown = request.sectionItems.find((row) => row._id === request.itemId);
    if (!shown || isSamePlace(request.sectionItems, shown, request)) {
        return null;
    }
    const owners = request.ownerIds ?? request.sectionItems.map((row) => row.userId);
    const section = await readRankSection(db, request.itemId, [...owners, shown.userId]);
    if (!section || !isSameContext(section, shown, request)) {
        return null;
    }
    const { moved, others } = section;
    const ranked = await ensureRunRanked(db, others, request);
    const above = request.aboveId === undefined ? undefined : ranked.get(request.aboveId);
    const below = request.belowId === undefined ? undefined : ranked.get(request.belowId);
    const rank = rankBetween(above?.rank, below?.rank);
    if (isRankTooLong(rank)) {
        return rebalanceAround(db, [...ranked.values()], moved, below);
    }
    const updated: StoredItem = { ...moved, rank, updatedTs: nowIso() };
    await putItem(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated, userId: updated.userId });
    return updated;
}

/** Re-keys the whole section with `item` placed right above `below` (or last) — the too-long-key escape hatch. */
async function rebalanceAround(db: IDBPDatabase<MyDB>, others: readonly StoredItem[], item: StoredItem, below: StoredItem | undefined): Promise<StoredItem> {
    const insertAt = below ? others.findIndex((row) => row._id === below._id) : others.length;
    const ordered = insertAt < 0 ? [...others, item] : [...others.slice(0, insertAt), item, ...others.slice(insertAt)];
    const rekeyed = await rebalanceSection(db, ordered);
    return rekeyed.find((row) => row._id === item._id) ?? item;
}

// ── Generic edit ──────────────────────────────────────────────────────────────

export async function updateItem(db: IDBPDatabase<MyDB>, item: StoredItem): Promise<StoredItem> {
    const updated: StoredItem = { ...item, updatedTs: nowIso() };
    await putItem(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'item', entityId: updated._id, snapshot: updated, userId: updated.userId });
    return updated;
}

/** Releases a snoozed item from the tickler by dropping `ignoreBefore` entirely — it becomes visible in its normal list immediately. */
export async function releaseFromTickler(db: IDBPDatabase<MyDB>, item: StoredItem): Promise<StoredItem> {
    const { ignoreBefore: _released, ...released } = item;
    return updateItem(db, released);
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
    await queueDeleteThenRemove(
        db,
        {
            opType: 'delete',
            entityType: 'item',
            entityId: itemId,
            snapshot: null,
            ...(existing?.userId ? { userId: existing.userId } : {}),
        },
        () => deleteItemById(db, itemId),
    );
}
