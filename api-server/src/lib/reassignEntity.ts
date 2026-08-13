import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import entityMovesDAO, { entityMoveReceiptId } from '../dataAccess/entityMovesDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import peopleDAO from '../dataAccess/peopleDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import workContextsDAO from '../dataAccess/workContextsDAO.js';
import {
    type EntitySnapshot,
    type EntityType,
    GCAL_OWNED_ROUTINE_KEYS,
    type ItemInterface,
    type PersonInterface,
    type RoutineInterface,
    type WorkContextInterface,
} from '../types/entities.js';
import { applyAndPublishOperation, OperationValidationError } from './applyOperation.js';
import { KeyedMutex } from './keyedMutex.js';
import { notifyChanges } from './notifyChange.js';
import { applyAndPublishOwnerMove, republishOwnerMoveOps } from './ownerMove.js';
import { ensureFirstRoutineItem } from './routineItemGeneration.js';
import { regenerateFutureRoutineItems } from './routineItemRegeneration.js';

/** Optional GCal target — REQUIRED when reassigning a calendar-linked item across accounts. */
export interface TargetCalendar {
    integrationId: string;
    syncConfigId: string;
}

/**
 * Whitelisted user-edited fields that ride along on a reassign for items. Lets the dialog
 * "edit + move" in one atomic call so we never write the source-user copy first (which the
 * old flow did, and which silently corrupted the row when the active session was the target).
 * The handler enforces the whitelist — `user`, `_id`, `updatedTs`, `routineId`, and any other
 * key not listed here are dropped before being merged onto the snapshot.
 */
export interface ReassignItemEditPatch {
    title?: string;
    notes?: string;
    timeStart?: string;
    timeEnd?: string;
    workContextIds?: string[];
    peopleIds?: string[];
    /** Energy level — empty string '' clears a previously-set value (matches the form's clear gesture). */
    energy?: ItemInterface['energy'] | '';
    /** Time estimate in minutes — empty string '' clears a previously-set value. */
    time?: number | '';
    urgent?: boolean;
    focus?: boolean;
    expectedBy?: string;
    ignoreBefore?: string;
    waitingForPersonId?: string;
    /** All-day flag — paired with date-only timeStart/timeEnd when true. */
    allDay?: boolean;
}

/** Whitelisted edit fields that ride along on a routine reassign. Same rationale as ReassignItemEditPatch. */
export interface ReassignRoutineEditPatch {
    title?: string;
    rrule?: string;
    recurrenceAnchor?: RoutineInterface['recurrenceAnchor'];
    startDate?: string;
    routineType?: RoutineInterface['routineType'];
    template?: RoutineInterface['template'];
    calendarItemTemplate?: RoutineInterface['calendarItemTemplate'];
    active?: boolean;
}

export interface ReassignParams {
    entityType: EntityType;
    entityId: string;
    fromUserId: string;
    toUserId: string;
    targetCalendar?: TargetCalendar;
    /** Item edits that ride along atomically. Ignored for non-item entityTypes. */
    editPatch?: ReassignItemEditPatch;
    /** Routine edits that ride along atomically. Ignored for non-routine entityTypes. */
    editRoutinePatch?: ReassignRoutineEditPatch;
    /**
     * Stamped on every recorded operation. Defaults to `'server'` for the in-app /sync/reassign
     * path; the public `/v1/reassign` route passes `api:<tokenId>` so audits can see which token
     * drove the move.
     */
    deviceId?: string;
}

/** Discriminated outcome — keeps callers narrowly typed without throwing for control flow. */
export type ReassignResult = { ok: true; alreadyMoved?: true } | { ok: false; status: 400 | 404; error: string; code?: 'validation_failed' };

/**
 * Serializes reassigns per entity so two concurrent moves of the same entity (double-click, two
 * tabs, a client retry racing the original) resolve as one 'moved' + one 'alreadyMoved' instead
 * of interleaving their read-validate-flip sequences. In-process lock — Cloud Run runs a single
 * instance (existing codebase assumption).
 */
const reassignMutex = new KeyedMutex();

/**
 * Top-level entry point. Branches by entityType so each case stays at one level of abstraction.
 * Catches `OperationValidationError` from the strict-mode apply pipeline and converts it to a
 * 400 `validation_failed` so callers (the v1/reassign route, the in-app /sync/reassign route)
 * can render a structured error without each having to re-implement the same try/catch.
 */
export async function reassignEntity(params: ReassignParams): Promise<ReassignResult> {
    try {
        return await reassignMutex.withLock(`reassign:${params.entityId}`, () => dispatchByEntityType(params));
    } catch (err) {
        if (err instanceof OperationValidationError) {
            return { ok: false, status: 400, error: err.failure.message, code: 'validation_failed' };
        }
        throw err;
    }
}

/**
 * Pure dispatcher — kept separate so reassignEntity can wrap the whole switch in one try/catch.
 *
 * People and workContexts are intentionally NOT reassignable. The previous "move the entity, leave
 * dangling cross-user refs, surface them in `crossUserReferences`" gesture put the burden on
 * callers to either strip or synthesize the broken pointers. The new model inverts that: when an
 * item or routine carrying `peopleIds`/`workContextIds` is moved, the orchestrator resolves each
 * referenced entity into the target user's account (find-or-create by email/name), so the moved
 * item lands with valid local references and the source user keeps an unchanged copy of the person
 * or workContext they originally owned.
 */
async function dispatchByEntityType(params: ReassignParams): Promise<ReassignResult> {
    switch (params.entityType) {
        case 'item':
            return reassignItem(params);
        case 'routine':
            return reassignRoutine(params);
        case 'person':
        case 'workContext':
            return {
                ok: false,
                status: 400,
                error: 'persons and workContexts cannot be reassigned — items/routines that reference them are auto-relinked into the target user on move',
                code: 'validation_failed',
            };
    }
}

// ── Item ─────────────────────────────────────────────────────────────────────

async function reassignItem(params: ReassignParams): Promise<ReassignResult> {
    const item = await itemsDAO.findByOwnerAndId(params.entityId, params.fromUserId);
    if (!item) {
        // Already-moved idempotency: a retry of a completed move (or the heal path for a crash
        // between the atomic flip and the op-log inserts) finds the entity under toUserId.
        const alreadyMoved = await resolveAlreadyMoved((id, uid) => itemsDAO.findByOwnerAndId(id, uid), 'item', params);
        return alreadyMoved ?? { ok: false, status: 404, error: 'Item not found under fromUserId' };
    }
    if (item.routineId) {
        return { ok: false, status: 400, error: 'Routine-generated items cannot be reassigned — edit the routine itself' };
    }
    // Apply the user's edits to the in-memory item first so the target snapshot (which drives the
    // async GCal create-on-target) reflects the updated title/time.
    const patchedItem = applyItemEditPatch(item, params.editPatch);
    // Run all early-rejection preconditions BEFORE relinking — once we commit mirror people /
    // workContexts under the target user there's no rollback path, so a 400 returned after the
    // relink would leave orphan records in the recipient's address book.
    const isCalendarLinked = Boolean(patchedItem.calendarEventId);
    if (isCalendarLinked && !params.targetCalendar) {
        return { ok: false, status: 400, error: 'targetCalendar is required for calendar-linked items' };
    }
    // DAO-only existence check — deliberately no provider/network call before the DB write. The
    // GCal side effects are op-driven after the flip: the delete-leg op (pre-move snapshot)
    // drives async source-event deletion, the create-leg op (unlinked snapshot stamped with the
    // target ids) drives async target-event creation.
    if (params.targetCalendar) {
        const targetError = await validateTargetCalendar(params.targetCalendar, params.toUserId);
        if (targetError) {
            return targetError;
        }
    }
    // Reference relinking runs after the edit patch so values the user explicitly typed in the
    // dialog still flow through find-or-create against the target user's people / workContext
    // space. A validation failure past this point can still orphan mirrors — accepted limitation:
    // the recipient simply gains an extra contact/context they can keep or delete.
    const relinkedItem = await relinkItemReferences(patchedItem, buildRelinkContext(params));
    const now = dayjs().toISOString();
    const outcome = await applyAndPublishOwnerMove(itemsDAO, {
        entityType: 'item',
        entityId: params.entityId,
        fromUserId: params.fromUserId,
        toUserId: params.toUserId,
        preMoveSnapshot: item,
        newSnapshot: buildTargetItemSnapshot(relinkedItem, params, now),
        deviceId: params.deviceId ?? 'server',
        now,
    });
    if (outcome === 'not-owned') {
        // Lost a race after the initial read: another mover flipped the row first. Resolve through
        // the same idempotency branch as the up-front miss.
        const alreadyMoved = await resolveAlreadyMoved((id, uid) => itemsDAO.findByOwnerAndId(id, uid), 'item', params);
        return alreadyMoved ?? { ok: false, status: 404, error: 'Item not found under fromUserId' };
    }
    return { ok: true };
}

/**
 * GCal linkage fields that never survive an owner move: they describe the SOURCE account's event,
 * which the delete-leg op is about to remove. The target-side event is created asynchronously by
 * pushback from the create-leg op and stamps fresh values.
 */
const ITEM_GCAL_FIELDS_TO_STRIP = [
    'calendarEventId',
    'htmlLink',
    'calendarInstanceEventId',
    'lastPushedToGCalTs',
    'lastSyncedFromGCalTs',
    'lastSyncedNotes',
    'eventType',
    'calendarIntegrationId',
    'calendarSyncConfigId',
] as const satisfies readonly (keyof ItemInterface)[];

/** Target-owner snapshot: GCal source linkage stripped, target calendar ids stamped when provided. */
function buildTargetItemSnapshot(item: ItemInterface, params: ReassignParams, now: string): ItemInterface {
    const next: ItemInterface = { ...item, user: params.toUserId, updatedTs: now };
    for (const key of ITEM_GCAL_FIELDS_TO_STRIP) {
        delete next[key];
    }
    if (params.targetCalendar) {
        // The stamped link makes the async pushback (`pushNewItemToGCal`) resolve the TARGET
        // calendar's push context instead of the target user's default calendar.
        next.calendarIntegrationId = params.targetCalendar.integrationId;
        next.calendarSyncConfigId = params.targetCalendar.syncConfigId;
    }
    return next;
}

/** DAO-only targetCalendar validation: integration + syncConfig must exist under toUserId. */
async function validateTargetCalendar(target: TargetCalendar, toUserId: string): Promise<ReassignResult | null> {
    const integration = await calendarIntegrationsDAO.findByOwnerAndId(target.integrationId, toUserId);
    if (!integration) {
        return { ok: false, status: 400, error: 'targetCalendar.integrationId not found under toUserId' };
    }
    const config = await calendarSyncConfigsDAO.findByOwnerAndId(target.syncConfigId, toUserId);
    if (!config || config.integrationId !== target.integrationId) {
        return { ok: false, status: 400, error: 'targetCalendar.syncConfigId not found under toUserId (or belongs to a different integration)' };
    }
    return null;
}

/**
 * Idempotency + crash-heal branch. When the entity is not under fromUserId but IS under toUserId
 * AND a move receipt proves this (entity, from, to) move was actually initiated, the move already
 * happened — report success with `alreadyMoved` AND re-emit both op-log legs so a crash between
 * the A1 flip and its log inserts self-heals on retry (flip-first ordering: the receipt is
 * written before the flip, so it always exists in that crash window).
 *
 * The receipt gate is load-bearing, not defensive: "present under toUserId" alone is equally
 * true of an entity toUserId has ALWAYS owned. Answering `alreadyMoved` there would forge op-log
 * legs on both users and republish the target's private snapshot to a caller who never held the
 * row. Returns null for both the receipt-less case and the entity-nowhere case — a genuine 404.
 */
async function resolveAlreadyMoved(
    // Narrowed lookup instead of the DAO itself — AbstractDAO<T> is invariant in T, so passing
    // concrete DAOs generically would force an unsound cast (same pattern as pickHydrationLookup).
    lookup: (entityId: string, userId: string) => Promise<EntitySnapshot | null>,
    entityType: EntityType,
    params: ReassignParams,
): Promise<ReassignResult | null> {
    const current = await lookup(params.entityId, params.toUserId);
    if (!current) {
        return null;
    }
    const receipt = await entityMovesDAO.findOne({ _id: entityMoveReceiptId(params.entityId, params.fromUserId, params.toUserId) });
    if (!receipt) {
        return null;
    }
    await republishOwnerMoveOps({ entityType, entityId: params.entityId, fromUserId: params.fromUserId, toUserId: params.toUserId }, current, {
        deviceId: params.deviceId ?? 'server',
        now: dayjs().toISOString(),
    });
    return { ok: true, alreadyMoved: true };
}

/**
 * Returns the item with whitelisted edit fields applied. Unrecognised keys (e.g. a forged `user`
 * or `updatedTs`) are silently dropped so a malicious client can't override server-authoritative
 * fields via the patch. Empty strings are treated as "clear this field" only for the optional
 * date/string fields where '' is the canonical empty value; for required fields like `title`
 * we keep the original when the patch's value is empty.
 */
// Exported for unit testing — the integration test for /sync/reassign covers calendar-linked
// move flow end-to-end; this lets focused tests target the patch-application step alone.
export function applyItemEditPatch(item: ItemInterface, patch: ReassignItemEditPatch | undefined): ItemInterface {
    if (!patch) {
        return item;
    }
    const next: ItemInterface = { ...item };
    // `title` is required on ItemInterface, so we ignore an empty patch.title (the dialog already
    // blocks save on an empty title); the rest of the optional fields use the standard empty-string
    // / empty-array semantics: '' or [] clears, anything else replaces.
    if (typeof patch.title === 'string' && patch.title.length > 0) {
        next.title = patch.title;
    }
    assignOptionalString(next, 'notes', patch.notes);
    assignOptionalString(next, 'timeStart', patch.timeStart);
    assignOptionalString(next, 'timeEnd', patch.timeEnd);
    assignOptionalString(next, 'expectedBy', patch.expectedBy);
    assignOptionalString(next, 'ignoreBefore', patch.ignoreBefore);
    assignOptionalString(next, 'waitingForPersonId', patch.waitingForPersonId);
    assignOptionalArray(next, 'workContextIds', patch.workContextIds);
    assignOptionalArray(next, 'peopleIds', patch.peopleIds);
    // Empty string '' is the "clear this field" sentinel — matches the form's clear gesture.
    // Invalid values (e.g. 'banana', NaN) are silently ignored so a malformed client request
    // can't break the move; legitimate clears go through the explicit '' branch.
    if (patch.energy === '') {
        delete next.energy;
    } else if (patch.energy === 'low' || patch.energy === 'medium' || patch.energy === 'high') {
        next.energy = patch.energy;
    }
    if (patch.time === '') {
        delete next.time;
    } else if (typeof patch.time === 'number' && Number.isFinite(patch.time)) {
        next.time = patch.time;
    }
    if (typeof patch.urgent === 'boolean') {
        next.urgent = patch.urgent;
    }
    if (typeof patch.focus === 'boolean') {
        next.focus = patch.focus;
    }
    // Toggling off clears the flag entirely (matches the rest-strip semantics used elsewhere); the
    // accompanying timeStart/timeEnd in the same patch convert from YYYY-MM-DD ↔ ISO datetime.
    if (patch.allDay === true) {
        next.allDay = true;
    } else if (patch.allDay === false) {
        delete next.allDay;
    }
    return next;
}

/** Set or clear an optional string field — '' clears so the dialog can drop a value cleanly. */
function assignOptionalString<T extends object, K extends keyof T>(target: T, key: K, value: unknown): void {
    if (typeof value !== 'string') {
        return;
    }
    if (value.length === 0) {
        delete target[key];
        return;
    }
    target[key] = value as T[K];
}

/** Set or clear an optional string-array field — [] clears so the dialog can drop all entries. */
function assignOptionalArray<T extends object, K extends keyof T>(target: T, key: K, value: unknown): void {
    if (!Array.isArray(value)) {
        return;
    }
    if (value.length === 0) {
        delete target[key];
        return;
    }
    target[key] = value as T[K];
}

// ── Routine ──────────────────────────────────────────────────────────────────

/**
 * Reassigns a routine across users.
 *
 * Source-side cleanup is performed by the cascade in `pushRoutineDeletion` (fired by the
 * delete-leg op published from `persistRoutineMove`, whose snapshot is the pre-move routine):
 *   - every routine-generated calendar item under `fromUserId` is moved to `status: 'trash'`
 *     (recoverable, not falsely marked done) — see `trashGeneratedCalendarItems`.
 *   - the routine's GCal recurring master event is hard-deleted from the source account.
 * Target-side: Bob receives the routine itself with the source calendar link stripped. When the
 * caller supplies `targetCalendar`, the target snapshot is stamped with Bob's
 * integration/syncConfig ids (no `calendarEventId`), so the create-leg op drives
 * `pushNewRoutineToGCal` to create a fresh series on Bob's calendar asynchronously. Without
 * `targetCalendar` the routine lands unlinked (today's behavior — Bob can link manually). His
 * item stream is seeded immediately by `seedTargetRoutineItems` (first nextAction item /
 * calendar horizon fill). He does NOT inherit Alice's historical generated items — those are
 * intentionally left as trash on the source side.
 */
async function reassignRoutine(params: ReassignParams): Promise<ReassignResult> {
    const routine = await routinesDAO.findByOwnerAndId(params.entityId, params.fromUserId);
    if (!routine) {
        // Same idempotency / crash-heal branch as items — see resolveAlreadyMoved.
        const alreadyMoved = await resolveAlreadyMoved((id, uid) => routinesDAO.findByOwnerAndId(id, uid), 'routine', params);
        return alreadyMoved ?? { ok: false, status: 404, error: 'Routine not found under fromUserId' };
    }
    if (params.targetCalendar) {
        const targetError = await validateTargetCalendar(params.targetCalendar, params.toUserId);
        if (targetError) {
            return targetError;
        }
    }
    // Count source-side calendar-status generated items BEFORE the cascade so the audit log
    // reflects what was actually trashed (`trashGeneratedCalendarItems` only touches
    // status='calendar' rows — done/trash rows are left as-is, by matrix design).
    const cascadedCount = (await itemsDAO.findArray({ user: params.fromUserId, routineId: params.entityId, status: 'calendar' })).length;
    const moved = await persistRoutineMove(routine, params);
    if (moved === 'not-owned') {
        const alreadyMoved = await resolveAlreadyMoved((id, uid) => routinesDAO.findByOwnerAndId(id, uid), 'routine', params);
        return alreadyMoved ?? { ok: false, status: 404, error: 'Routine not found under fromUserId' };
    }
    // Seed the new owner's item stream immediately — no client tick covers this: the SSE-driven
    // per-user pull never runs the nextAction materialize backstop, and calendar routines have no
    // backstop at all, so without this the moved routine sits itemless on the target indefinitely.
    await seedTargetRoutineItems(moved, params);
    console.log(
        `[reassign] cascaded routine source-cleanup | routineId=${params.entityId} fromUserId=${params.fromUserId} toUserId=${params.toUserId} cascadedItems=${cascadedCount} gcalEventId=${routine.calendarEventId ?? '(none)'}`,
    );
    return { ok: true };
}

/**
 * GCal linkage + sync anchors that never survive a routine owner move — they all describe the
 * SOURCE account's series (which the delete-leg cascade removes) or its sync history. A fresh
 * target-side series (when `targetCalendar` is given) stamps fresh values via pushback.
 * `lastKnown*` disconnect-keep markers are shed too: a later reconnect on the target must not
 * strong-key relink the SOURCE account's series onto the moved routine.
 */
const ROUTINE_GCAL_FIELDS_TO_STRIP = [
    'calendarEventId',
    'calendarIntegrationId',
    'calendarSyncConfigId',
    'calendarRebasedEventId',
    'lastPushedToGCalTs',
    'lastSyncedFromGCalTs',
    'lastSyncedNotes',
    'lastKnownCalendarEventId',
    'lastKnownCalendarIntegrationId',
    'lastKnownCalendarSyncConfigId',
    'lastKnownCalendarAccountEmail',
    // GCal-owned master mirrors (organizer, location, meetingLink, …) describe the source series;
    // carrying them over would stamp stale metadata onto the target's fresh series and items.
    ...GCAL_OWNED_ROUTINE_KEYS,
] as const satisfies readonly (keyof RoutineInterface)[];

/**
 * Atomic routine owner flip via `applyAndPublishOwnerMove`. The target snapshot sheds every
 * source-calendar field; with `targetCalendar` it is stamped with the new owner's
 * integration/syncConfig ids so the create-leg op asynchronously creates the series on the
 * target's GCal. Returns 'not-owned' when the flip matched nothing (concurrent move won).
 */
async function persistRoutineMove(routine: RoutineInterface, params: ReassignParams): Promise<RoutineInterface | 'not-owned'> {
    const strippedRoutine: RoutineInterface = { ...routine };
    for (const key of ROUTINE_GCAL_FIELDS_TO_STRIP) {
        delete strippedRoutine[key];
    }
    // No open-item propagation (routineEditPropagation.ts) is needed here, by architecture:
    // generated items never accompany the routine across accounts — source-side ones are trashed
    // by the delete cascade, and every target-side item is generated FROM this patched snapshot,
    // so the edit patch is already the single source of truth for the new owner's items.
    const patched = applyRoutineEditPatch(strippedRoutine, params.editRoutinePatch);
    // Relink template.workContextIds / peopleIds AFTER the edit patch — same rationale as the item
    // path: explicit dialog edits flow through the same find-or-create as snapshot-inherited refs.
    // buildRelinkContext also provides the per-batch dedup caches that keep two ids sharing an
    // email/name from racing duplicate mirror creates.
    const ctx = buildRelinkContext(params);
    const relinked = await relinkRoutineReferences(patched, ctx);
    const newSnapshot: RoutineInterface = {
        ...relinked,
        user: params.toUserId,
        updatedTs: ctx.now,
        // Stamping only the integration link (never calendarEventId) makes `pushNewRoutineToGCal`
        // treat the routine as link-pending and create a fresh series with a deterministic id.
        ...(params.targetCalendar
            ? { calendarIntegrationId: params.targetCalendar.integrationId, calendarSyncConfigId: params.targetCalendar.syncConfigId }
            : {}),
    };
    const outcome = await applyAndPublishOwnerMove(routinesDAO, {
        entityType: 'routine',
        entityId: params.entityId,
        fromUserId: params.fromUserId,
        toUserId: params.toUserId,
        preMoveSnapshot: routine,
        newSnapshot,
        deviceId: ctx.deviceId,
        now: ctx.now,
    });
    return outcome === 'not-owned' ? 'not-owned' : newSnapshot;
}

/**
 * Materialize the moved routine's items under the new owner. Runs after the move committed, so
 * failures must never surface as a reassign error — `ensureFirstRoutineItem` swallows its own
 * errors, and the calendar leg is wrapped here to match that contract.
 *
 * nextAction: same first-item bootstrap as POST /v1/routines.
 * calendar: idempotent horizon fill via `regenerateFutureRoutineItems`. The moved routine never
 * carries a `calendarEventId` at this point (persistRoutineMove strips it; a target series is
 * created asynchronously by pushback when `targetCalendar` was given), so no timeZone is needed
 * and the regen ops carry no instance ids; `suppressGCalPushback` mirrors the edit-propagation
 * path — the fresh items must not push events onto the target's GCal.
 */
async function seedTargetRoutineItems(routine: RoutineInterface, params: ReassignParams): Promise<void> {
    const ctx = { userId: params.toUserId, deviceId: params.deviceId ?? 'server' };
    if (routine.routineType === 'nextAction') {
        await ensureFirstRoutineItem(ctx, routine);
        return;
    }
    try {
        const ops = await regenerateFutureRoutineItems(routine, params.toUserId, dayjs().toISOString());
        if (ops.length > 0) {
            await notifyChanges(ops, { suppressGCalPushback: true });
        }
    } catch (err) {
        console.error('[reassign] failed to seed calendar items for moved routine; move stands', { routineId: routine._id, err });
    }
}

/**
 * Returns the routine with whitelisted edit fields applied. Unrecognised keys are silently
 * dropped — same trust-boundary rationale as applyItemEditPatch.
 */
function applyRoutineEditPatch(routine: RoutineInterface, patch: ReassignRoutineEditPatch | undefined): RoutineInterface {
    if (!patch) {
        return routine;
    }
    const next: RoutineInterface = { ...routine };
    // `title` and `rrule` are required on RoutineInterface — we only replace when given a non-empty
    // value. `startDate` is optional, so '' clears via the same convention as item fields.
    if (typeof patch.title === 'string' && patch.title.length > 0) {
        next.title = patch.title;
    }
    if (typeof patch.rrule === 'string' && patch.rrule.length > 0) {
        next.rrule = patch.rrule;
    }
    assignOptionalString(next, 'startDate', patch.startDate);
    if (patch.routineType === 'nextAction' || patch.routineType === 'calendar') {
        next.routineType = patch.routineType;
    }
    if (patch.template !== undefined && typeof patch.template === 'object' && patch.template !== null) {
        next.template = patch.template;
    }
    if (patch.calendarItemTemplate !== undefined && typeof patch.calendarItemTemplate === 'object' && patch.calendarItemTemplate !== null) {
        next.calendarItemTemplate = patch.calendarItemTemplate;
    }
    if (typeof patch.active === 'boolean') {
        next.active = patch.active;
    }
    // recurrenceAnchor is only meaningful for nextAction routines — RoutineSnapshotSchema rejects
    // it on a calendar routine. `next` starts as a spread of the source routine, so a type switch
    // away from nextAction must explicitly CLEAR any inherited anchor, not just skip applying the
    // patch's value — otherwise a stale anchor rides along and fails validation on the target write.
    if (next.routineType === 'nextAction') {
        if (patch.recurrenceAnchor === 'floating' || patch.recurrenceAnchor === 'fixed') {
            next.recurrenceAnchor = patch.recurrenceAnchor;
        }
    } else {
        delete next.recurrenceAnchor;
    }
    // GCal master-mirror fields are calendar-only (RoutineSnapshotSchema superRefine) — same
    // rationale as the recurrenceAnchor clear above: a type switch away from calendar must shed
    // them or the target-side create fails validation on inherited fields.
    if (next.routineType !== 'calendar') {
        for (const key of GCAL_OWNED_ROUTINE_KEYS) {
            delete next[key];
        }
    }
    // A type switch also drops the disconnect-with-keep markers — mirrors PATCH /v1/routines: a
    // later reconnect's strong-key restore must not relink the old series onto the switched routine.
    if (next.routineType !== routine.routineType) {
        delete next.lastKnownCalendarEventId;
        delete next.lastKnownCalendarIntegrationId;
        delete next.lastKnownCalendarSyncConfigId;
        delete next.lastKnownCalendarAccountEmail;
    }
    return next;
}

// ── Cross-user reference relinking ───────────────────────────────────────────

/**
 * Resolves source-user `peopleIds` / `workContextIds` / `waitingForPersonId` to ids that exist
 * under `toUserId`, creating mirror entities when the target user has no matching record. Used by
 * both the item and routine reassign paths so a moved entity lands with valid local references
 * instead of dangling cross-user pointers.
 *
 * Matching policy:
 *   - workContext: exact, case-sensitive `name`.
 *   - person: email-first (when both source and a target candidate have an email and it matches
 *     exactly), then fall back to exact `name`. Email wins because it's more unique than a name —
 *     two people can share a first name far more easily than they share an inbox.
 *
 * When no match is found, a new entity is created under `toUserId` mirroring the source entity's
 * display fields (name + email/phone/notes/externalCalendarId for people; just name for
 * workContexts). The new entity is persisted via `applyAndPublishOperation` so the standard
 * fan-out (SSE / web push / webhooks / op log) fires on the target user's channel.
 *
 * Source-user entities are NEVER mutated or deleted by this helper — the user reassigning an
 * item doesn't lose the contact / context they originally owned.
 *
 * Ids referencing entities the source user no longer owns (e.g. a stale ref from a previously
 * trashed person) are passed through unchanged: the strict-mode snapshot validator would already
 * accept the row, and the new owner inherits the same dangling state the source had.
 */
/**
 * Per-relink-batch state. The two `*Cache` maps dedupe within a single reassign call so two refs
 * sharing an email/name (or the same id repeated) reuse the first resolution instead of racing
 * to insert duplicate mirror rows under the recipient. Keyed by:
 *   - peopleCache: `email:<value>` when source person has email; `name:<value>` otherwise.
 *   - contextsCache: `name:<value>`.
 * `null` means "we already looked and there's no match under the recipient yet" — but since the
 * very next branch creates one and writes the new id back into the cache, that null is only ever
 * read by re-entry of the same id within the same array (relink runs sequentially, so by the
 * time the second hit sees the cache the first hit has already replaced null with the new id).
 */
interface RelinkContext {
    fromUserId: string;
    toUserId: string;
    deviceId: string;
    now: string;
    peopleCache: Map<string, string>;
    contextsCache: Map<string, string>;
}

/** Sequential walk + per-batch dedup. Promise.all would race two same-key creates into duplicates. */
async function relinkPeopleIds(ids: string[] | undefined, ctx: RelinkContext): Promise<string[] | undefined> {
    if (!ids || ids.length === 0) {
        return ids;
    }
    const out: string[] = [];
    for (const id of ids) {
        out.push(await relinkPersonId(id, ctx));
    }
    return out;
}

async function relinkPersonId(id: string, ctx: RelinkContext): Promise<string> {
    const sourcePerson = await peopleDAO.findByOwnerAndId(id, ctx.fromUserId);
    // No source-side record: stale id (entity no longer owned by source user, or never was).
    // Pass through unchanged — the new owner inherits the same dangling state the source had.
    if (!sourcePerson) {
        return id;
    }
    const cacheKey = personCacheKey(sourcePerson);
    const cached = ctx.peopleCache.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }
    const existing = await findPersonByEmailOrName(ctx.toUserId, sourcePerson);
    if (existing) {
        ctx.peopleCache.set(cacheKey, existing._id);
        return existing._id;
    }
    const created = await createPersonForUser(sourcePerson, ctx);
    ctx.peopleCache.set(cacheKey, created._id);
    return created._id;
}

/** Same priority as the find: email-first when present, name otherwise. */
function personCacheKey(source: PersonInterface): string {
    return source.email ? `email:${source.email}` : `name:${source.name}`;
}

/** Email-first match, then name. Both comparisons are case-sensitive exact (no normalization). */
async function findPersonByEmailOrName(userId: string, source: PersonInterface): Promise<PersonInterface | null> {
    if (source.email) {
        const byEmail = await peopleDAO.findOne({ user: userId, email: source.email });
        if (byEmail) {
            return byEmail;
        }
    }
    return peopleDAO.findOne({ user: userId, name: source.name });
}

async function createPersonForUser(source: PersonInterface, ctx: RelinkContext): Promise<PersonInterface> {
    const newId = randomUUID();
    const snapshot: PersonInterface = {
        _id: newId,
        user: ctx.toUserId,
        name: source.name,
        // Mirror only display fields — never copy `_id`, `user`, or timestamps from the source row.
        // `archived` carries over deliberately: mirroring an archived person as active would
        // resurrect them into the recipient's pickers.
        ...(source.email !== undefined ? { email: source.email } : {}),
        ...(source.phone !== undefined ? { phone: source.phone } : {}),
        ...(source.externalCalendarId !== undefined ? { externalCalendarId: source.externalCalendarId } : {}),
        ...(source.notes !== undefined ? { notes: source.notes } : {}),
        ...(source.archived !== undefined ? { archived: source.archived } : {}),
        createdTs: ctx.now,
        updatedTs: ctx.now,
    };
    await applyAndPublishOperation(
        ctx.toUserId,
        { entityType: 'person', entityId: newId, snapshot, opType: 'create' },
        { deviceId: ctx.deviceId, now: ctx.now, strict: true },
    );
    return snapshot;
}

async function relinkWorkContextIds(ids: string[] | undefined, ctx: RelinkContext): Promise<string[] | undefined> {
    if (!ids || ids.length === 0) {
        return ids;
    }
    const out: string[] = [];
    for (const id of ids) {
        out.push(await relinkWorkContextId(id, ctx));
    }
    return out;
}

async function relinkWorkContextId(id: string, ctx: RelinkContext): Promise<string> {
    const source = await workContextsDAO.findByOwnerAndId(id, ctx.fromUserId);
    if (!source) {
        return id;
    }
    const cacheKey = `name:${source.name}`;
    const cached = ctx.contextsCache.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }
    const existing = await workContextsDAO.findOne({ user: ctx.toUserId, name: source.name });
    if (existing) {
        ctx.contextsCache.set(cacheKey, existing._id);
        return existing._id;
    }
    const created = await createWorkContextForUser(source, ctx);
    ctx.contextsCache.set(cacheKey, created._id);
    return created._id;
}

async function createWorkContextForUser(source: WorkContextInterface, ctx: RelinkContext): Promise<WorkContextInterface> {
    const newId = randomUUID();
    const snapshot: WorkContextInterface = {
        _id: newId,
        user: ctx.toUserId,
        name: source.name,
        // Mirror the archive state — an archived context must not resurrect as active in the
        // recipient's pickers.
        ...(source.archived !== undefined ? { archived: source.archived } : {}),
        createdTs: ctx.now,
        updatedTs: ctx.now,
    };
    await applyAndPublishOperation(
        ctx.toUserId,
        { entityType: 'workContext', entityId: newId, snapshot, opType: 'create' },
        { deviceId: ctx.deviceId, now: ctx.now, strict: true },
    );
    return snapshot;
}

/** Returns a relink context with one wall-clock + deviceId + dedup caches shared across every helper call. */
function buildRelinkContext(params: ReassignParams): RelinkContext {
    return {
        fromUserId: params.fromUserId,
        toUserId: params.toUserId,
        deviceId: params.deviceId ?? 'server',
        now: dayjs().toISOString(),
        peopleCache: new Map(),
        contextsCache: new Map(),
    };
}

/**
 * Rewrites an item's `peopleIds`, `waitingForPersonId`, and `workContextIds` in-place against the
 * target user's people / workContext space. Called from `reassignItem` after `applyItemEditPatch`
 * so explicitly-edited references still flow through the same find-or-create resolution as
 * snapshot-inherited ones.
 */
async function relinkItemReferences(item: ItemInterface, ctx: RelinkContext): Promise<ItemInterface> {
    const next: ItemInterface = { ...item };
    const relinkedPeople = await relinkPeopleIds(next.peopleIds, ctx);
    if (relinkedPeople !== undefined) {
        next.peopleIds = relinkedPeople;
    }
    const relinkedContexts = await relinkWorkContextIds(next.workContextIds, ctx);
    if (relinkedContexts !== undefined) {
        next.workContextIds = relinkedContexts;
    }
    if (next.waitingForPersonId) {
        next.waitingForPersonId = await relinkPersonId(next.waitingForPersonId, ctx);
    }
    return next;
}

/** Routine template carries the same shape of refs; applied to the routine in-place. */
async function relinkRoutineReferences(routine: RoutineInterface, ctx: RelinkContext): Promise<RoutineInterface> {
    if (!routine.template) {
        return routine;
    }
    const template = { ...routine.template };
    const relinkedPeople = await relinkPeopleIds(template.peopleIds, ctx);
    if (relinkedPeople !== undefined) {
        template.peopleIds = relinkedPeople;
    }
    const relinkedContexts = await relinkWorkContextIds(template.workContextIds, ctx);
    if (relinkedContexts !== undefined) {
        template.workContextIds = relinkedContexts;
    }
    return { ...routine, template };
}
