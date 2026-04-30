import dayjs from 'dayjs';
import type { CalendarProvider } from '../calendarProviders/CalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import peopleDAO from '../dataAccess/peopleDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import workContextsDAO from '../dataAccess/workContextsDAO.js';
import type {
    CalendarIntegrationInterface,
    EntitySnapshot,
    EntityType,
    ItemInterface,
    PersonInterface,
    RoutineInterface,
    WorkContextInterface,
} from '../types/entities.js';
import { ensureTimeZone } from './calendarPushback.js';
import { markdownToHtml } from './markdownHtml.js';
import { recordOperation } from './operationHelpers.js';

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
}

/** Whitelisted edit fields that ride along on a routine reassign. Same rationale as ReassignItemEditPatch. */
export interface ReassignRoutineEditPatch {
    title?: string;
    rrule?: string;
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
}

export type ReassignProviderFactory = (integration: CalendarIntegrationInterface, userId: string) => CalendarProvider;

/** Discriminated outcome — keeps callers narrowly typed without throwing for control flow. */
export type ReassignResult =
    | { ok: true; crossUserReferences?: { peopleIds?: string[]; workContextIds?: string[] } }
    | { ok: false; status: 400 | 404 | 502; error: string };

/** Top-level entry point. Branches by entityType so each case stays at one level of abstraction. */
export async function reassignEntity(params: ReassignParams, buildProvider: ReassignProviderFactory): Promise<ReassignResult> {
    switch (params.entityType) {
        case 'item':
            return reassignItem(params, buildProvider);
        case 'routine':
            return reassignRoutine(params, buildProvider);
        case 'person':
            return reassignPerson(params);
        case 'workContext':
            return reassignWorkContext(params);
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
    const isCalendarLinked = Boolean(patchedItem.calendarEventId);
    if (isCalendarLinked && !params.targetCalendar) {
        return { ok: false, status: 400, error: 'targetCalendar is required for calendar-linked items' };
    }
    if (isCalendarLinked && params.targetCalendar) {
        const moved = await moveItemAcrossCalendars(patchedItem, params, buildProvider);
        if (!moved.ok) {
            return moved;
        }
        await persistItemMove(moved.item, params);
        return { ok: true };
    }
    await persistItemMove(patchedItem, params);
    return { ok: true };
}

/**
 * Returns the item with whitelisted edit fields applied. Unrecognised keys (e.g. a forged `user`
 * or `updatedTs`) are silently dropped so a malicious client can't override server-authoritative
 * fields via the patch. Empty strings are treated as "clear this field" only for the optional
 * date/string fields where '' is the canonical empty value; for required fields like `title`
 * we keep the original when the patch's value is empty.
 */
function applyItemEditPatch(item: ItemInterface, patch: ReassignItemEditPatch | undefined): ItemInterface {
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
    const newEventId = await createOnTargetCalendar(targetCtx, item);
    if (newEventId === null) {
        return { ok: false, status: 502, error: 'Failed to create event on target calendar' };
    }
    await bestEffortDeleteOnSource(item, params, buildProvider);
    return {
        ok: true,
        item: {
            ...item,
            calendarEventId: newEventId,
            calendarIntegrationId: targetCtx.integration._id,
            calendarSyncConfigId: targetCtx.config._id,
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
        return null;
    }
    const config = await calendarSyncConfigsDAO.findByOwnerAndId(configId, userId);
    if (!config) {
        return null;
    }
    const provider = buildProvider(integration, userId);
    const timeZone = await ensureTimeZone(config, provider);
    return { integration, config, provider, timeZone };
}

async function createOnTargetCalendar(ctx: PushCtx, item: ItemInterface): Promise<string | null> {
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
        console.warn(`[reassign] source push context missing — leaving stub event ${item.calendarEventId} on source GCal`);
        return;
    }
    try {
        await sourceCtx.provider.deleteEvent(sourceCtx.config.calendarId, item.calendarEventId);
    } catch (err) {
        console.error(`[reassign] failed to delete source GCal event ${item.calendarEventId} — leaving stub on source`, err);
    }
}

/** Common path for both calendar-linked and plain items: delete from source, create under target, record both ops. */
async function persistItemMove(item: ItemInterface, params: ReassignParams): Promise<void> {
    const now = dayjs().toISOString();
    const newSnapshot: ItemInterface = { ...item, user: params.toUserId, updatedTs: now };
    await itemsDAO.deleteByOwner(params.entityId, params.fromUserId);
    await itemsDAO.replaceById(params.entityId, newSnapshot);
    await recordOperation(params.fromUserId, { entityType: 'item', entityId: params.entityId, snapshot: null, opType: 'delete', now });
    await recordOperation(params.toUserId, { entityType: 'item', entityId: params.entityId, snapshot: newSnapshot, opType: 'create', now });
}

// ── Routine ──────────────────────────────────────────────────────────────────

const MAX_GENERATED_ITEMS_PER_REASSIGN = 500;

async function reassignRoutine(params: ReassignParams, _buildProvider: ReassignProviderFactory): Promise<ReassignResult> {
    const routine = await routinesDAO.findByOwnerAndId(params.entityId, params.fromUserId);
    if (!routine) {
        return { ok: false, status: 404, error: 'Routine not found under fromUserId' };
    }
    // _buildProvider is reserved for a future GCal master-series re-link. Step 5 keeps the master
    // event under the original account; only single calendar items move across accounts here.
    await persistRoutineMove(routine, params);
    const movedCount = await reassignGeneratedItems(params);
    if (movedCount >= MAX_GENERATED_ITEMS_PER_REASSIGN) {
        console.warn(`[reassign] routine ${params.entityId} hit generated-items cap (${MAX_GENERATED_ITEMS_PER_REASSIGN}) — remaining items left under source`);
    }
    return { ok: true };
}

/**
 * Routine itself: strip GCal link on the new owner so the new owner doesn't push to the
 * original account's GCal. The master series stays under the original account; the user can
 * re-link manually if desired. Step 5's GCal move only covers single calendar items;
 * recurring-event re-linking is deferred.
 */
async function persistRoutineMove(routine: RoutineInterface, params: ReassignParams): Promise<void> {
    const now = dayjs().toISOString();
    // Destructure to drop the keys entirely (rather than assigning undefined) to keep
    // exactOptionalPropertyTypes happy.
    const { calendarEventId: _ce, calendarIntegrationId: _ci, calendarSyncConfigId: _cs, ...routineWithoutCalLinks } = routine;
    const patched = applyRoutineEditPatch(routineWithoutCalLinks as RoutineInterface, params.editRoutinePatch);
    const newSnapshot: RoutineInterface = { ...patched, user: params.toUserId, updatedTs: now };
    await routinesDAO.deleteByOwner(params.entityId, params.fromUserId);
    await routinesDAO.replaceById(params.entityId, newSnapshot);
    await recordOperation(params.fromUserId, { entityType: 'routine', entityId: params.entityId, snapshot: null, opType: 'delete', now });
    await recordOperation(params.toUserId, { entityType: 'routine', entityId: params.entityId, snapshot: newSnapshot, opType: 'create', now });
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
    return next;
}

/** Moves every generated item belonging to the routine across to the target user. Returns the count moved. */
async function reassignGeneratedItems(params: ReassignParams): Promise<number> {
    const generated = await itemsDAO.findArray({ user: params.fromUserId, routineId: params.entityId }, { limit: MAX_GENERATED_ITEMS_PER_REASSIGN });
    if (!generated.length) {
        return 0;
    }
    for (const item of generated) {
        if (!item._id) {
            continue;
        }
        await persistItemMove(item, { ...params, entityId: item._id });
    }
    return generated.length;
}

// ── Person / WorkContext ─────────────────────────────────────────────────────

async function reassignPerson(params: ReassignParams): Promise<ReassignResult> {
    const person = await peopleDAO.findByOwnerAndId(params.entityId, params.fromUserId);
    if (!person) {
        return { ok: false, status: 404, error: 'Person not found under fromUserId' };
    }
    const referencingItemIds = await findItemsReferencing(params.fromUserId, 'peopleIds', params.entityId);
    await persistSimpleEntityMove<PersonInterface>(person, params, peopleDAO, 'person');
    return referencingItemIds.length ? { ok: true, crossUserReferences: { peopleIds: referencingItemIds } } : { ok: true };
}

async function reassignWorkContext(params: ReassignParams): Promise<ReassignResult> {
    const workContext = await workContextsDAO.findByOwnerAndId(params.entityId, params.fromUserId);
    if (!workContext) {
        return { ok: false, status: 404, error: 'WorkContext not found under fromUserId' };
    }
    const referencingItemIds = await findItemsReferencing(params.fromUserId, 'workContextIds', params.entityId);
    await persistSimpleEntityMove<WorkContextInterface>(workContext, params, workContextsDAO, 'workContext');
    return referencingItemIds.length ? { ok: true, crossUserReferences: { workContextIds: referencingItemIds } } : { ok: true };
}

/** Scans items under the source user for the given array reference field — used to surface cross-user refs in the response. */
async function findItemsReferencing(userId: string, field: 'peopleIds' | 'workContextIds', refId: string): Promise<string[]> {
    const items = await itemsDAO.findArray({ user: userId, [field]: refId });
    return items.map((i) => i._id).filter((id): id is string => Boolean(id));
}

// Generic DAO subset accepted by persistSimpleEntityMove — covers the three operations we need
// without leaking AbstractDAO's full Mongo-typed surface into this helper module.
interface SimpleEntityDAO<T extends EntitySnapshot> {
    deleteByOwner(entityId: string, userId: string): Promise<void>;
    replaceById(entityId: string, doc: T): Promise<void>;
}

/** Person + workContext share a pure delete-then-create-with-new-user path. */
async function persistSimpleEntityMove<T extends PersonInterface | WorkContextInterface>(
    entity: T,
    params: ReassignParams,
    dao: SimpleEntityDAO<T>,
    entityType: 'person' | 'workContext',
): Promise<void> {
    const now = dayjs().toISOString();
    const newSnapshot: T = { ...entity, user: params.toUserId, updatedTs: now };
    await dao.deleteByOwner(params.entityId, params.fromUserId);
    await dao.replaceById(params.entityId, newSnapshot);
    await recordOperation(params.fromUserId, { entityType, entityId: params.entityId, snapshot: null, opType: 'delete', now });
    await recordOperation(params.toUserId, { entityType, entityId: params.entityId, snapshot: newSnapshot, opType: 'create', now });
}
