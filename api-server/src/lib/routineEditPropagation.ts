import dayjs from 'dayjs';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import type { ItemInterface, RoutineInterface } from '../types/entities.js';
import { applyAndPublishOperation } from './applyOperation.js';
import { notifyChanges } from './notifyChange.js';
import { ensureFirstRoutineItem, type RoutineItemGenerationContext } from './routineItemGeneration.js';
import { propagateRoutineContentToItems, regenerateFutureRoutineItems, trashFutureCalendarItems } from './routineItemRegeneration.js';
import { computeFirstOccurrenceDate, mergeRoutineEditIntoOpenItem } from './routineOpenItemMerge.js';
import { isCalendarScheduleChanged, isNextActionScheduleChanged } from './rruleCanonical.js';
import { RruleExhaustedError } from './rruleHelpers.js';

/**
 * Server-side twin of the client editor's routine-edit → item propagation (Phase 2 in
 * `client/src/components/routineEditor/RoutineEditorBody.tsx`): a PATCH /v1/routines edit (MCP,
 * public API) must update the routine's generated items immediately, not on the next client tick.
 *
 * Semantics (agreed product decisions — keep in lockstep with the client):
 *  - nextAction: 3-way content merge into the open native-status item (hand-tweaks survive);
 *    schedule edits (rrule or startDate) recompute expectedBy/ignoreBefore unconditionally;
 *    an exhausted schedule trashes the pending item and deactivates the routine.
 *  - calendar: schedule edits run the idempotent delta regeneration; content-only edits update
 *    title/notes on future items in place (per-instance GCal overrides win).
 *  - Only active routines propagate; done/trash/transformed items are never touched.
 *  - type switch (nextAction ↔ calendar): the old type's native items are trashed (future-only
 *    for calendar history) and the new type's stream is seeded. The PATCH handler rejects type
 *    switches on GCal-linked routines, so no master-series handling is needed here.
 *
 * Never throws: item propagation must not fail the parent PATCH. Errors are logged and the
 * routine write stands. Returns the routine's final state — the exhausted path deactivates it
 * AFTER the PATCH already persisted `active: true`, and the response must reflect that.
 */
export async function propagateRoutineEditToItems(
    ctx: RoutineItemGenerationContext,
    previous: RoutineInterface,
    next: RoutineInterface,
): Promise<RoutineInterface> {
    try {
        if (previous.routineType === 'nextAction' && next.routineType === 'nextAction') {
            return await syncOpenItemAfterRoutineEdit(ctx, previous, next);
        }
        if (previous.routineType === 'calendar' && next.routineType === 'calendar') {
            await propagateCalendarRoutineEdit(ctx, previous, next);
            return next;
        }
        return await transitionRoutineTypeItems(ctx, previous, next);
    } catch (err) {
        console.error('[routine] edit propagation to items failed; routine write stands', { routineId: next._id, err });
        return next;
    }
}

/** The routine's open item still in its native `nextAction` status (at most one by invariant). */
async function findOpenNativeItem(userId: string, routineId: string): Promise<ItemInterface | null> {
    return itemsDAO.findOne({ user: userId, routineId, status: 'nextAction' } as never);
}

/** Publish an item update through the shared apply pipeline (op log + SSE + push + webhooks). */
async function publishItemUpdate(ctx: RoutineItemGenerationContext, item: ItemInterface, now: string): Promise<void> {
    await applyAndPublishOperation(
        ctx.userId,
        { entityType: 'item', opType: 'update', entityId: item._id ?? '', snapshot: item },
        { deviceId: `api:${ctx.tokenId}`, now },
    );
}

/**
 * nextAction propagation: content merge + unconditional schedule recompute. Mirrors the client's
 * `syncOpenItemAfterNextActionEdit` decision-for-decision.
 */
async function syncOpenItemAfterRoutineEdit(ctx: RoutineItemGenerationContext, previous: RoutineInterface, next: RoutineInterface): Promise<RoutineInterface> {
    if (!next.active) {
        return next;
    }
    const openItem = await findOpenNativeItem(ctx.userId, next._id);
    if (!openItem) {
        return next;
    }
    const now = dayjs().toISOString();
    // Read-modify-write window: a concurrent client edit landing between this read and the write
    // below loses to our fresher updatedTs (LWW). Accepted — schedule fields are "edit wins" by
    // design, and the content merge only rewrites fields that matched the pre-edit template.
    const merged = mergeRoutineEditIntoOpenItem(openItem, { previous, next, now });
    if (!isNextActionScheduleChanged(previous, next)) {
        if (merged) {
            await publishItemUpdate(ctx, merged, now);
        }
        return next;
    }
    return recomputeOpenItemSchedule(ctx, next, { openItem, contentMerged: merged, now });
}

/**
 * Re-stamps the open item's `expectedBy`/`ignoreBefore` to the edited schedule's first occurrence
 * (tickler invariant: both move together). An exhausted rrule trashes the pending item and
 * deactivates the routine — the returned routine carries `active: false` so the PATCH response
 * reflects the final state.
 */
async function recomputeOpenItemSchedule(
    ctx: RoutineItemGenerationContext,
    routine: RoutineInterface,
    state: { openItem: ItemInterface; contentMerged: ItemInterface | null; now: string },
): Promise<RoutineInterface> {
    const base = state.contentMerged ?? state.openItem;
    try {
        const expectedBy = computeFirstOccurrenceDate(routine, dayjs().format('YYYY-MM-DD'));
        if (expectedBy === state.openItem.expectedBy && state.openItem.ignoreBefore === expectedBy && !state.contentMerged) {
            return routine;
        }
        await publishItemUpdate(ctx, { ...base, expectedBy, ignoreBefore: expectedBy, updatedTs: state.now }, state.now);
        return routine;
    } catch (err) {
        if (!(err instanceof RruleExhaustedError)) {
            throw err;
        }
        await publishItemUpdate(ctx, { ...state.openItem, status: 'trash', updatedTs: state.now }, state.now);
        const deactivated: RoutineInterface = { ...routine, active: false, updatedTs: state.now };
        await applyAndPublishOperation(
            ctx.userId,
            { entityType: 'routine', opType: 'update', entityId: routine._id, snapshot: deactivated },
            { deviceId: `api:${ctx.tokenId}`, now: state.now },
        );
        return deactivated;
    }
}

/**
 * Calendar propagation: schedule edits reconcile the future item set via the idempotent delta
 * regeneration; content-only edits rename/re-note future items in place. Ops recorded by those
 * helpers bypass the apply pipeline (they write the DAO directly), so the notification fan-out
 * runs here explicitly — without it, live tabs and other devices would not learn about the new
 * items until their next full pull.
 */
async function propagateCalendarRoutineEdit(ctx: RoutineItemGenerationContext, previous: RoutineInterface, next: RoutineInterface): Promise<void> {
    if (!next.active) {
        return;
    }
    const now = dayjs().toISOString();
    const ops = isCalendarScheduleChanged(previous, next)
        ? await regenerateFutureRoutineItems(next, ctx.userId, now, await lookupCalendarTimeZone(next))
        : await propagateRoutineContentToItems(next, ctx.userId, now);
    if (ops.length > 0) {
        // suppressGCalPushback: the routine op published by the PATCH already updated the GCal
        // MASTER via handleRoutinePush — letting these per-item regen ops reach maybePushToGCal
        // would layer per-instance overrides/cancellations on top of the fresh master (the
        // self-referential fork churn class). For in-app routines pushback is a no-op anyway.
        // Same reasoning as the inbound-sync path, which fans out via notifyDevicesOfSyncOps.
        await notifyChanges(ops, { suppressGCalPushback: true });
    }
}

/**
 * Type switch (nextAction ↔ calendar): trash the old type's native-status items, then seed the new
 * type. Mirrors the client editor's `transitionRoutineType` decision-for-decision:
 *  - old nextAction: trash the open native item(s) regardless of date — the new stream reseeds.
 *  - old calendar: trash future items only; past occurrences remain in the app as history.
 *  - new calendar: horizon fill via the idempotent delta regen (no-op when the routine is paused).
 *  - new nextAction: `ensureFirstRoutineItem` (open-item guard + exhausted-rrule deactivation).
 * Returns the routine re-read after seeding — an exhausted new schedule deactivates it and the
 * PATCH response must reflect that.
 */
async function transitionRoutineTypeItems(ctx: RoutineItemGenerationContext, previous: RoutineInterface, next: RoutineInterface): Promise<RoutineInterface> {
    const now = dayjs().toISOString();
    if (previous.routineType === 'nextAction') {
        await trashOpenNativeItems(ctx, previous, now);
        const ops = await regenerateFutureRoutineItems(next, ctx.userId, now, await lookupCalendarTimeZone(next));
        if (ops.length > 0) {
            // suppressGCalPushback: same reasoning as propagateCalendarRoutineEdit — the routine op
            // published by the PATCH already drives any GCal master work via handleRoutinePush.
            await notifyChanges(ops, { suppressGCalPushback: true });
        }
        return next;
    }
    const trashedOps = await trashFutureCalendarItems(previous, ctx.userId, now);
    if (trashedOps.length > 0) {
        await notifyChanges(trashedOps, { suppressGCalPushback: true });
    }
    await ensureFirstRoutineItem(ctx, next, { ignoreCalendarHistory: true });
    // ensureFirstRoutineItem deactivates on an exhausted rrule via its own op — re-read so the
    // caller returns the final state, mirroring the exhausted path of the nextAction recompute.
    return (await routinesDAO.findByOwnerAndId(next._id, ctx.userId)) ?? next;
}

/** Trash every item still in native `nextAction` status for the routine (at most one by invariant,
 *  but sweep all matches so a historical duplicate can't survive the switch). */
async function trashOpenNativeItems(ctx: RoutineItemGenerationContext, routine: RoutineInterface, now: string): Promise<void> {
    const openNative = await itemsDAO.findArray({ user: ctx.userId, routineId: routine._id, status: 'nextAction' });
    for (const item of openNative) {
        await publishItemUpdate(ctx, { ...item, status: 'trash', updatedTs: now }, now);
    }
}

/** The linked calendar's IANA timezone — needed to derive GCal instance ids for timed series. */
async function lookupCalendarTimeZone(routine: RoutineInterface): Promise<string | undefined> {
    if (!routine.calendarSyncConfigId) {
        return undefined;
    }
    const config = await calendarSyncConfigsDAO.findOne({ _id: routine.calendarSyncConfigId, user: routine.user } as never);
    return config?.timeZone;
}
