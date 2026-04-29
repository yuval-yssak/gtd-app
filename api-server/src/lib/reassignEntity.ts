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

export interface ReassignParams {
    entityType: EntityType;
    entityId: string;
    fromUserId: string;
    toUserId: string;
    targetCalendar?: TargetCalendar;
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
    const isCalendarLinked = Boolean(item.calendarEventId);
    if (isCalendarLinked && !params.targetCalendar) {
        return { ok: false, status: 400, error: 'targetCalendar is required for calendar-linked items' };
    }
    if (isCalendarLinked && params.targetCalendar) {
        const moved = await moveItemAcrossCalendars(item, params, buildProvider);
        if (!moved.ok) {
            return moved;
        }
        await persistItemMove(moved.item, params);
        return { ok: true };
    }
    await persistItemMove(item, params);
    return { ok: true };
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
    const newSnapshot: RoutineInterface = { ...routineWithoutCalLinks, user: params.toUserId, updatedTs: now };
    await routinesDAO.deleteByOwner(params.entityId, params.fromUserId);
    await routinesDAO.replaceById(params.entityId, newSnapshot);
    await recordOperation(params.fromUserId, { entityType: 'routine', entityId: params.entityId, snapshot: null, opType: 'delete', now });
    await recordOperation(params.toUserId, { entityType: 'routine', entityId: params.entityId, snapshot: newSnapshot, opType: 'create', now });
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
