import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import type { CalendarProvider } from '../calendarProviders/CalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import peopleDAO from '../dataAccess/peopleDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import workContextsDAO from '../dataAccess/workContextsDAO.js';
import { validateOperation } from '../schemas/operations/index.js';
import {
    type CalendarIntegrationInterface,
    type EntityType,
    GCAL_OWNED_ROUTINE_KEYS,
    type ItemInterface,
    type PersonInterface,
    type RoutineInterface,
    type WorkContextInterface,
} from '../types/entities.js';
import { applyAndPublishOperation, OperationValidationError } from './applyOperation.js';
import { ensureTimeZone } from './calendarPushback.js';
import { markdownToHtml } from './markdownHtml.js';
import { notifyChanges } from './notifyChange.js';
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

export type ReassignProviderFactory = (integration: CalendarIntegrationInterface, userId: string) => CalendarProvider;

/** Discriminated outcome — keeps callers narrowly typed without throwing for control flow. */
export type ReassignResult =
    | { ok: true; crossUserReferences?: { peopleIds?: string[]; workContextIds?: string[] } }
    | { ok: false; status: 400 | 404 | 502; error: string; code?: 'validation_failed' };

/**
 * Top-level entry point. Branches by entityType so each case stays at one level of abstraction.
 * Catches `OperationValidationError` from the strict-mode apply pipeline and converts it to a
 * 400 `validation_failed` so callers (the v1/reassign route, the in-app /sync/reassign route)
 * can render a structured error without each having to re-implement the same try/catch.
 */
export async function reassignEntity(params: ReassignParams, buildProvider: ReassignProviderFactory): Promise<ReassignResult> {
    try {
        return await dispatchByEntityType(params, buildProvider);
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
async function dispatchByEntityType(params: ReassignParams, buildProvider: ReassignProviderFactory): Promise<ReassignResult> {
    switch (params.entityType) {
        case 'item':
            return reassignItem(params, buildProvider);
        case 'routine':
            return reassignRoutine(params, buildProvider);
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

async function reassignItem(params: ReassignParams, buildProvider: ReassignProviderFactory): Promise<ReassignResult> {
    const item = await itemsDAO.findByOwnerAndId(params.entityId, params.fromUserId);
    if (!item) {
        return { ok: false, status: 404, error: 'Item not found under fromUserId' };
    }
    if (item.routineId) {
        return { ok: false, status: 400, error: 'Routine-generated items cannot be reassigned — edit the routine itself' };
    }
    // Apply the user's edits to the in-memory item before any GCal call so create-on-target
    // reflects the updated title/time, and persistItemMove writes the patched snapshot.
    const patchedItem = applyItemEditPatch(item, params.editPatch);
    // Run all early-rejection preconditions BEFORE relinking — once we commit mirror people /
    // workContexts under the target user there's no rollback path, so a 400 returned after the
    // relink would leave orphan records in the recipient's address book.
    const isCalendarLinked = Boolean(patchedItem.calendarEventId);
    if (isCalendarLinked && !params.targetCalendar) {
        return { ok: false, status: 400, error: 'targetCalendar is required for calendar-linked items' };
    }
    // Reference relinking runs after the edit patch so values the user explicitly typed in the
    // dialog still flow through find-or-create against the target user's people / workContext space.
    // Calendar-linked failures past this point can still orphan mirrors (GCal create-on-target,
    // for example) — that's an accepted limitation since the recipient simply gains an extra
    // contact/context they can keep or delete; the alternative would be a multi-step rollback
    // dance that doesn't pay for itself given how rare those failures are.
    const relinkedItem = await relinkItemReferences(patchedItem, buildRelinkContext(params));
    if (isCalendarLinked && params.targetCalendar) {
        const moved = await moveItemAcrossCalendars(relinkedItem, params, buildProvider);
        if (!moved.ok) {
            return moved;
        }
        await persistItemMove(moved.item, params);
        return { ok: true };
    }
    await persistItemMove(relinkedItem, params);
    return { ok: true };
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

interface MovedItemResult {
    ok: true;
    item: ItemInterface;
}

/** Performs the GCal create-on-target then best-effort delete-on-source dance for a calendar-linked item. */
async function moveItemAcrossCalendars(
    item: ItemInterface,
    params: ReassignParams,
    buildProvider: ReassignProviderFactory,
): Promise<MovedItemResult | { ok: false; status: 502; error: string }> {
    if (!params.targetCalendar) {
        return { ok: false, status: 502, error: 'unreachable' };
    }
    const targetCtx = await loadPushContext(params.targetCalendar.integrationId, params.targetCalendar.syncConfigId, params.toUserId, buildProvider);
    if (!targetCtx) {
        return { ok: false, status: 502, error: 'Target calendar not found' };
    }
    const createdEvent = await createOnTargetCalendar(targetCtx, item);
    if (createdEvent === null) {
        return { ok: false, status: 502, error: 'Failed to create event on target calendar' };
    }
    await bestEffortDeleteOnSource(item, params, buildProvider);
    // The source event is deleted above, so its htmlLink would dangle — replace it with the new
    // event's link, or drop it entirely when the create didn't report one.
    const { htmlLink: _staleSourceLink, ...itemWithoutStaleLink } = item;
    return {
        ok: true,
        item: {
            ...itemWithoutStaleLink,
            calendarEventId: createdEvent.eventId,
            calendarIntegrationId: targetCtx.integration._id,
            calendarSyncConfigId: targetCtx.config._id,
            ...(createdEvent.htmlLink ? { htmlLink: createdEvent.htmlLink } : {}),
        },
    };
}

interface PushCtx {
    integration: CalendarIntegrationInterface;
    config: { _id: string; calendarId: string; timeZone?: string };
    provider: CalendarProvider;
    timeZone: string;
}

async function loadPushContext(integrationId: string, configId: string, userId: string, buildProvider: ReassignProviderFactory): Promise<PushCtx | null> {
    const integration = await calendarIntegrationsDAO.findByOwnerAndIdDecrypted(integrationId, userId);
    if (!integration) {
        console.warn(`[reassign] loadPushContext: integration not found | integrationId=${integrationId} userId=${userId}`);
        return null;
    }
    const config = await calendarSyncConfigsDAO.findByOwnerAndId(configId, userId);
    if (!config) {
        console.warn(`[reassign] loadPushContext: syncConfig not found | configId=${configId} userId=${userId}`);
        return null;
    }
    const provider = buildProvider(integration, userId);
    const timeZone = await ensureTimeZone(config, provider);
    return { integration, config, provider, timeZone };
}

async function createOnTargetCalendar(ctx: PushCtx, item: ItemInterface) {
    if (!item.timeStart || !item.timeEnd) {
        return null;
    }
    try {
        return await ctx.provider.createEvent(
            ctx.config.calendarId,
            {
                title: item.title,
                timeStart: item.timeStart,
                timeEnd: item.timeEnd,
                ...(item.notes !== undefined ? { description: markdownToHtml(item.notes) } : {}),
            },
            ctx.timeZone,
        );
    } catch (err) {
        console.error('[reassign] createEvent on target calendar failed', err);
        return null;
    }
}

/** Best-effort delete of the GCal event on the source calendar. Logs failures but never blocks the move. */
async function bestEffortDeleteOnSource(item: ItemInterface, params: ReassignParams, buildProvider: ReassignProviderFactory): Promise<void> {
    if (!item.calendarEventId || !item.calendarIntegrationId || !item.calendarSyncConfigId) {
        return;
    }
    const sourceCtx = await loadPushContext(item.calendarIntegrationId, item.calendarSyncConfigId, params.fromUserId, buildProvider);
    if (!sourceCtx) {
        // Fallback: if the item's integrationId/configId doesn't resolve under fromUserId (e.g.
        // because a stale id from a prior account move was carried in the row), look for any active
        // integration owned by fromUserId that has a syncConfig pointing at the same calendarId we
        // care about. We don't know that calendarId without the original config, so just try every
        // active integration of fromUserId — this is best-effort only and runs once per move.
        await fallbackDeleteAcrossUserCalendars(item, params, buildProvider);
        return;
    }
    try {
        await sourceCtx.provider.deleteEvent(sourceCtx.config.calendarId, item.calendarEventId);
    } catch (err) {
        console.error(`[reassign] failed to delete source GCal event ${item.calendarEventId} — leaving stub on source`, err);
    }
}

/**
 * Last-ditch attempt to delete the source-side GCal event when the item's stored integration/config
 * ids are stale or otherwise unresolvable under fromUserId. Walks every integration owned by
 * fromUserId (no status filter — matches the primary path's loadPushContext, which also accepts
 * suspended integrations during the 24h grace), and probes each integration's sync configs.
 * Logs an aggregate warning if every attempt fails — but never throws, since the move has already
 * succeeded on the target side and we don't want to roll that back.
 */
async function fallbackDeleteAcrossUserCalendars(item: ItemInterface, params: ReassignParams, buildProvider: ReassignProviderFactory): Promise<void> {
    if (!item.calendarEventId) {
        return;
    }
    const integrations = await calendarIntegrationsDAO.findByUserDecrypted(params.fromUserId);
    if (integrations.length === 0) {
        console.warn(
            `[reassign] source push context missing and no integrations for fromUserId — leaving stub event ${item.calendarEventId} on source GCal | staleIntegrationId=${item.calendarIntegrationId} staleSyncConfigId=${item.calendarSyncConfigId}`,
        );
        return;
    }
    let lastError: unknown;
    for (const integration of integrations) {
        const result = await probeDeleteOnIntegration(integration, item.calendarEventId, params.fromUserId, buildProvider);
        if (result.ok) {
            console.warn(
                `[reassign] fallback deleted source GCal event ${item.calendarEventId} via integration=${integration._id} config=${result.configId} | staleIntegrationId=${item.calendarIntegrationId} staleSyncConfigId=${item.calendarSyncConfigId}`,
            );
            return;
        }
        if (result.lastError !== undefined) {
            lastError = result.lastError;
        }
    }
    const errSummary = lastError instanceof Error ? `${lastError.name}: ${lastError.message}` : String(lastError ?? 'no attempts made');
    console.warn(
        `[reassign] source push context missing and fallback probes did not find event — leaving stub event ${item.calendarEventId} on source GCal (last error: ${errSummary})`,
    );
}

/**
 * Probes a single integration's sync configs for the given eventId. Resolves on the first config
 * whose deleteEvent succeeds, otherwise records the last per-attempt error so the caller can
 * surface it in the aggregate warn. Per-attempt errors include 404 (event not on this calendar —
 * the dominant case during a sweep) and 401/403/transport — all swallowed here to keep the sweep
 * best-effort, but tracked so the caller can summarise the failure mode.
 */
async function probeDeleteOnIntegration(
    integration: CalendarIntegrationInterface,
    eventId: string,
    fromUserId: string,
    buildProvider: ReassignProviderFactory,
): Promise<{ ok: true; configId: string } | { ok: false; lastError?: unknown }> {
    const configs = await calendarSyncConfigsDAO.findArray({ integrationId: integration._id, user: fromUserId });
    if (configs.length === 0) {
        return { ok: false };
    }
    const provider = buildProvider(integration, fromUserId);
    let lastError: unknown;
    for (const config of configs) {
        try {
            await provider.deleteEvent(config.calendarId, eventId);
            return { ok: true, configId: config._id };
        } catch (err) {
            lastError = err;
        }
    }
    return { ok: false, lastError };
}

/**
 * Pre-validates the create-leg snapshot BEFORE the source delete fires. Without this guard a
 * malformed (or matrix-violating) snapshot would land us in a torn state — source deleted,
 * target failed to create. We replay the same Zod check `applyAndPublishOperation` runs in
 * strict mode and throw the same `OperationValidationError` the apply pipeline would, so the
 * top-level catch in `reassignEntity` produces the same `validation_failed` 400 either way.
 */
function preValidateTargetSnapshot(raw: {
    entityType: EntityType;
    entityId: string;
    snapshot: ItemInterface | RoutineInterface | PersonInterface | WorkContextInterface;
}): void {
    const validation = validateOperation({ ...raw, opType: 'create' });
    if (!validation.ok) {
        throw new OperationValidationError(validation);
    }
}

/**
 * Common path for both calendar-linked and plain items. Drives both the source delete and the
 * target create through `applyAndPublishOperation` so SSE / web push / GCal pushback / webhook
 * fan-out fire on BOTH user channels. Delete on fromUserId completes before the create on
 * toUserId so a webhook subscriber on the target never observes a duplicate before the source
 * has been cleared. `applyAndPublishOperation` handles the per-collection delete + replaceById
 * via `applyEntityOp` — we no longer call the DAOs directly here.
 *
 * `suppressGCalPushback: true` on both legs because the calendar-linked path already drove the
 * GCal create-on-target + delete-on-source inline via `moveItemAcrossCalendars`. Without this,
 * `notifyChange` would re-push the create-leg snapshot to the target's GCal, producing a duplicate
 * event. For non-calendar items the flag is a no-op (`maybePushToGCal` returns early when
 * `calendarEventId` is absent and the matrix-allowed status forbids it). The routine path does NOT
 * pass this flag — the routine cascade in `pushRoutineDeletion` is the desired source-side cleanup.
 */
async function persistItemMove(item: ItemInterface, params: ReassignParams): Promise<void> {
    const now = dayjs().toISOString();
    const deviceId = params.deviceId ?? 'server';
    const newSnapshot: ItemInterface = { ...item, user: params.toUserId, updatedTs: now };
    // Pre-validate before the source delete so a torn move (deleted on source, failed on target)
    // is impossible. Throws OperationValidationError → top-level catch maps to a 400.
    preValidateTargetSnapshot({ entityType: 'item', entityId: params.entityId, snapshot: newSnapshot });
    await applyAndPublishOperation(
        params.fromUserId,
        { entityType: 'item', entityId: params.entityId, snapshot: null, opType: 'delete' },
        { deviceId, now, strict: true, suppressGCalPushback: true },
    );
    await applyAndPublishOperation(
        params.toUserId,
        { entityType: 'item', entityId: params.entityId, snapshot: newSnapshot, opType: 'create' },
        { deviceId, now, strict: true, suppressGCalPushback: true },
    );
}

// ── Routine ──────────────────────────────────────────────────────────────────

/**
 * Reassigns a routine across users.
 *
 * Source-side cleanup is performed by the cascade in `pushRoutineDeletion` (fired by the
 * source-leg delete inside `persistRoutineMove`):
 *   - every routine-generated calendar item under `fromUserId` is moved to `status: 'trash'`
 *     (recoverable, not falsely marked done) — see `trashGeneratedCalendarItems`.
 *   - the routine's GCal recurring master event is hard-deleted from the source account.
 * Target-side: Bob receives the routine itself with calendar-link fields stripped (so he doesn't
 * push to Alice's GCal) and his item stream is seeded immediately by `seedTargetRoutineItems`
 * (first nextAction item / calendar horizon fill). He does NOT inherit Alice's historical
 * generated items — those are intentionally left as trash on the source side.
 *
 * `_buildProvider` is reserved for a future GCal master-series re-link.
 */
async function reassignRoutine(params: ReassignParams, _buildProvider: ReassignProviderFactory): Promise<ReassignResult> {
    const routine = await routinesDAO.findByOwnerAndId(params.entityId, params.fromUserId);
    if (!routine) {
        return { ok: false, status: 404, error: 'Routine not found under fromUserId' };
    }
    // Count source-side calendar-status generated items BEFORE the cascade so the audit log
    // reflects what was actually trashed (`trashGeneratedCalendarItems` only touches
    // status='calendar' rows — done/trash rows are left as-is, by matrix design).
    const cascadedCount = (await itemsDAO.findArray({ user: params.fromUserId, routineId: params.entityId, status: 'calendar' })).length;
    const movedRoutine = await persistRoutineMove(routine, params);
    // Seed the new owner's item stream immediately — no client tick covers this: the SSE-driven
    // per-user pull never runs the nextAction materialize backstop, and calendar routines have no
    // backstop at all, so without this the moved routine sits itemless on the target indefinitely.
    await seedTargetRoutineItems(movedRoutine, params);
    console.log(
        `[reassign] cascaded routine source-cleanup | routineId=${params.entityId} fromUserId=${params.fromUserId} toUserId=${params.toUserId} cascadedItems=${cascadedCount} gcalEventId=${routine.calendarEventId ?? '(none)'}`,
    );
    return { ok: true };
}

/**
 * Routine itself: strip GCal link on the new owner so the new owner doesn't push to the
 * original account's GCal. The master series stays under the original account; the user can
 * re-link manually if desired. Step 5's GCal move only covers single calendar items;
 * recurring-event re-linking is deferred.
 */
async function persistRoutineMove(routine: RoutineInterface, params: ReassignParams): Promise<RoutineInterface> {
    // Destructure to drop the keys entirely (rather than assigning undefined) to keep
    // exactOptionalPropertyTypes happy.
    const { calendarEventId: _ce, calendarIntegrationId: _ci, calendarSyncConfigId: _cs, ...routineWithoutCalLinks } = routine;
    // No open-item propagation (routineEditPropagation.ts) is needed here, by architecture:
    // generated items never accompany the routine across accounts — source-side ones are trashed
    // by the delete cascade, and every target-side item is generated FROM this patched snapshot,
    // so the edit patch is already the single source of truth for the new owner's items.
    const patched = applyRoutineEditPatch(routineWithoutCalLinks as RoutineInterface, params.editRoutinePatch);
    // Relink template.workContextIds / peopleIds AFTER the edit patch — same rationale as the item
    // path: explicit dialog edits flow through the same find-or-create as snapshot-inherited refs.
    // buildRelinkContext also provides the per-batch dedup caches that keep two ids sharing an
    // email/name from racing duplicate mirror creates.
    const ctx = buildRelinkContext(params);
    const relinked = await relinkRoutineReferences(patched, ctx);
    const newSnapshot: RoutineInterface = { ...relinked, user: params.toUserId, updatedTs: ctx.now };
    preValidateTargetSnapshot({ entityType: 'routine', entityId: params.entityId, snapshot: newSnapshot });
    // Same source-delete-then-target-create discipline as persistItemMove — see that helper for
    // the rationale on why each leg flows through applyAndPublishOperation rather than the DAO.
    await applyAndPublishOperation(
        params.fromUserId,
        { entityType: 'routine', entityId: params.entityId, snapshot: null, opType: 'delete' },
        { deviceId: ctx.deviceId, now: ctx.now, strict: true },
    );
    await applyAndPublishOperation(
        params.toUserId,
        { entityType: 'routine', entityId: params.entityId, snapshot: newSnapshot, opType: 'create' },
        { deviceId: ctx.deviceId, now: ctx.now, strict: true },
    );
    return newSnapshot;
}

/**
 * Materialize the moved routine's items under the new owner. Runs after the move committed, so
 * failures must never surface as a reassign error — `ensureFirstRoutineItem` swallows its own
 * errors, and the calendar leg is wrapped here to match that contract.
 *
 * nextAction: same first-item bootstrap as POST /v1/routines.
 * calendar: idempotent horizon fill via `regenerateFutureRoutineItems`. The moved routine is never
 * GCal-linked (persistRoutineMove strips the link fields), so no timeZone is needed and the regen
 * ops carry no instance ids; `suppressGCalPushback` mirrors the edit-propagation path — the fresh
 * items must not push events onto the target's GCal.
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
