import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import itemsDAO from '../dataAccess/itemsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import type { ItemInterface, OperationInterface, RoutineInterface } from '../types/entities.js';
import { applyAndPublishOperation, applyAndPublishOperations, type RawOperation } from './applyOperation.js';
import { ensureFirstRoutineItem } from './routineItemGeneration.js';
import { addUntilToRrule } from './routineSplitUtils.js';
import { userLocalDate } from './userTimezone.js';

/**
 * Server-side orchestrators for the routine pause / resume / split composite gestures. Each
 * decomposes into primitive `applyAndPublishOperation` calls so the same validation, op log,
 * SSE/web-push/webhook fan-out, and GCal pushback (via `handleRoutinePush` in
 * `lib/calendarPushback.ts`) cover the public surface — no contract drift with `/sync/push`.
 *
 * **Calendar-routine seeding:** unlike the client-side split (`client/src/db/routineSplit.ts`)
 * which immediately seeds the tail's first item(s), the server-side split does NOT materialize
 * tail items. Calendar items are generated client-side from the routine's RRULE on the next
 * sync (`generateCalendarItemsToHorizon` lives in the client only). The trade-off is that a
 * pure-API consumer will not see new items appear until a connected client syncs — the master
 * GCal event is still created via `handleRoutinePush`. Documented in `PUBLIC_API.md`.
 */

interface CompositeContext {
    userId: string;
    tokenId: string;
}

export type CompositeResult = { ok: true; routine: RoutineInterface } | { ok: false; status: 404 | 409; code: string; message: string };

/**
 * Pause a routine: trash every future open item tied to it, then flip `active=false`. The order
 * matters — trashing first means another device can't race the flip and find a window where the
 * routine is paused but its items are still open. The forward-looking date is `timeStart` for
 * calendar items, `expectedBy` for nextAction items; past-due open items are intentionally left
 * alone (the pause invariant is forward-looking).
 *
 * GCal cap-with-UNTIL is fired downstream by `handleRoutinePush` when the routine update op
 * lands in `notifyChange`. No extra orchestration needed here.
 */
export async function pauseRoutine(ctx: CompositeContext, routineId: string): Promise<CompositeResult> {
    const routine = await routinesDAO.findByOwnerAndId(routineId, ctx.userId);
    if (!routine) {
        return { ok: false, status: 404, code: 'not_found', message: 'routine not found' };
    }
    const now = dayjs().toISOString();
    // User-local today — "future" is judged against the user's calendar day, not the server's.
    const todayStr = await userLocalDate(ctx.userId);
    await trashFutureOpenItemsForRoutine(ctx, routineId, todayStr, now);
    return updateRoutine(ctx, routine, { active: false }, now);
}

/**
 * Resume a routine: flip `active=true` and stamp `startDate=tomorrow` so the on-device generator
 * starts a fresh series instead of replaying past skips. Mirrors the existing client-side resume
 * gesture (memory: "resume via edit dialog + new startDate").
 */
export async function resumeRoutine(ctx: CompositeContext, routineId: string): Promise<CompositeResult> {
    const routine = await routinesDAO.findByOwnerAndId(routineId, ctx.userId);
    if (!routine) {
        return { ok: false, status: 404, code: 'not_found', message: 'routine not found' };
    }
    const now = dayjs().toISOString();
    // User-local tomorrow — a resume near midnight must restart the series on the user's next day.
    const tomorrow = await userLocalDate(ctx.userId, 1);
    const result = await updateRoutine(ctx, routine, { active: true, startDate: tomorrow }, now);
    // Materialize the first nextAction item against the resumed routine. Pause has already
    // trashed any future-dated open items, so without this the resumed series produces nothing
    // until a manual intervention. No-op for calendar routines and errors are swallowed inside.
    await ensureFirstRoutineItem({ userId: ctx.userId, deviceId: `api:${ctx.tokenId}` }, result.routine);
    return result;
}

export interface SplitParams {
    splitDate: string; // ISO date YYYY-MM-DD
    /** Edit fields applied to the new tail routine. Only the user-settable subset; same shape as PATCH. */
    tailEdits?: {
        title?: string;
        rrule?: string;
        recurrenceAnchor?: 'floating' | 'fixed';
        routineType?: 'nextAction' | 'calendar';
        template?: RoutineInterface['template'];
        calendarItemTemplate?: RoutineInterface['calendarItemTemplate'];
        startDate?: string;
        active?: boolean;
    };
}

export type SplitResult = { ok: true; head: RoutineInterface; tail: RoutineInterface } | { ok: false; status: 404 | 400; code: string; message: string };

/**
 * Split a routine at `splitDate`: cap the head (UNTIL + active=false), delete the head's future
 * calendar items, and create a new tail routine carrying the user's edits. Mirrors
 * `client/src/db/routineSplit.ts:21-73` but runs server-side so public-API callers can perform
 * the same atomic gesture. See module-level note above for tail-item seeding.
 */
export async function splitRoutine(ctx: CompositeContext, routineId: string, params: SplitParams): Promise<SplitResult> {
    const head = await routinesDAO.findByOwnerAndId(routineId, ctx.userId);
    if (!head) {
        return { ok: false, status: 404, code: 'not_found', message: 'routine not found' };
    }
    const now = dayjs().toISOString();
    const cappedHead = buildCappedHead(head, params.splitDate, now);
    const tail = buildTail(head, params, now);
    await deleteFutureCalendarItemsForRoutine(ctx, head._id, params.splitDate);
    // A nextAction head's open native item must be trashed too (any date — the tail seeds its
    // replacement below); the future-calendar delete above never matches it, so without this the
    // open next action survives on the capped head and duplicates the tail's seed.
    if (head.routineType === 'nextAction') {
        await trashOpenNextActionItemsForRoutine(ctx, head._id, now);
    }
    // Submit head-cap and tail-create as a single batch so the operations log preserves their
    // intended order even when other writes are interleaving in parallel.
    await applyAndPublishOperations(
        ctx.userId,
        [
            { entityType: 'routine', opType: 'update', entityId: head._id, snapshot: cappedHead },
            { entityType: 'routine', opType: 'create', entityId: tail._id, snapshot: tail },
        ],
        { deviceId: `api:${ctx.tokenId}`, now, strict: true },
    );
    // nextAction tails materialize their first item server-side (mirrors resumeRoutine) so a
    // pure-API split — including a type-switch split (calendar head → nextAction tail) — produces
    // a pending item without waiting for a client tick. No-op for calendar tails (see module note).
    await ensureFirstRoutineItem({ userId: ctx.userId, deviceId: `api:${ctx.tokenId}` }, tail);
    return { ok: true, head: cappedHead, tail };
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function trashFutureOpenItemsForRoutine(ctx: CompositeContext, routineId: string, fromDate: string, now: string): Promise<void> {
    const candidates = await itemsDAO.findArray({ user: ctx.userId, routineId } as never);
    const futureOpen = candidates.filter((i) => isFutureOpen(i, fromDate));
    if (!futureOpen.length) {
        return;
    }
    // Drop calendarInstanceEventId on trash so a paused GCal routine's items release their slot on the
    // presence-partial (user, calendarInstanceEventId) unique index. Otherwise resume — or a later split
    // successor on the same master — regenerates the same deterministic ids, E11000s, and the inserts are
    // silently swallowed (→ invisible occurrences). applyEntitySnapshotOp replaceById's the full snapshot,
    // so omitting the key unsets it. Symmetric to deactivateRoutineFromGCal on the GCal-sync side.
    const ops: RawOperation[] = futureOpen.map((item) => {
        const { calendarInstanceEventId: _freed, ...rest } = item;
        return {
            entityType: 'item',
            opType: 'update' as const,
            entityId: item._id ?? '',
            snapshot: { ...rest, status: 'trash' as const, updatedTs: now },
        };
    });
    await applyAndPublishOperations(ctx.userId, ops, { deviceId: `api:${ctx.tokenId}`, now, strict: true });
}

/** Trash (update op) every item still in native `nextAction` status for the routine. Trash — not
 *  hard delete — so other devices converge via LWW, matching the pause gesture's discipline. */
async function trashOpenNextActionItemsForRoutine(ctx: CompositeContext, routineId: string, now: string): Promise<void> {
    const openNative = await itemsDAO.findArray({ user: ctx.userId, routineId, status: 'nextAction' } as never);
    if (!openNative.length) {
        return;
    }
    const ops: RawOperation[] = openNative.map((item) => ({
        entityType: 'item',
        opType: 'update' as const,
        entityId: item._id ?? '',
        snapshot: { ...item, status: 'trash' as const, updatedTs: now },
    }));
    await applyAndPublishOperations(ctx.userId, ops, { deviceId: `api:${ctx.tokenId}`, now, strict: true });
}

async function deleteFutureCalendarItemsForRoutine(ctx: CompositeContext, routineId: string, fromDate: string): Promise<OperationInterface[]> {
    const candidates = await itemsDAO.findArray({ user: ctx.userId, routineId } as never);
    const futureCalendar = candidates.filter((i) => i.status === 'calendar' && (i.timeStart ?? '') >= fromDate);
    if (!futureCalendar.length) {
        return [];
    }
    const ops: RawOperation[] = futureCalendar.map((item) => ({
        entityType: 'item',
        opType: 'delete',
        entityId: item._id ?? '',
        snapshot: null,
    }));
    const { ops: deleteOps } = await applyAndPublishOperations(ctx.userId, ops, { deviceId: `api:${ctx.tokenId}`, strict: true });
    return deleteOps;
}

function isFutureOpen(item: ItemInterface, fromDate: string): boolean {
    if (item.status === 'done' || item.status === 'trash') {
        return false;
    }
    const forwardDate = item.timeStart ?? item.expectedBy ?? '';
    return forwardDate >= fromDate;
}

function buildCappedHead(head: RoutineInterface, splitDate: string, now: string): RoutineInterface {
    const cappedRrule = addUntilToRrule(head.rrule, splitDate);
    // Prune exceptions referencing dates the capped routine no longer generates — orphan
    // exception rows otherwise drift forever through sync.
    const keptExceptions = (head.routineExceptions ?? []).filter((exc) => exc.date < splitDate);
    const { routineExceptions: _existing, ...rest } = head;
    // Bump updatedTs so LWW (in `applyEntityOp`) accepts the cap. Without this, a concurrent
    // unrelated routine.update with a later updatedTs would silently drop our cap when both
    // ops replay against the same row.
    return {
        ...rest,
        rrule: cappedRrule,
        active: false,
        updatedTs: now,
        ...(keptExceptions.length > 0 ? { routineExceptions: keptExceptions } : {}),
    };
}

function buildTail(head: RoutineInterface, params: SplitParams, now: string): RoutineInterface {
    const edits = params.tailEdits ?? {};
    // Build the tail explicitly so we don't accidentally carry the head's `calendarEventId` (which
    // points at the head's GCal master series). `calendarIntegrationId` and `calendarSyncConfigId`
    // ARE propagated so the tail re-syncs to the same calendar — only the per-series event id is
    // dropped. The tail will publish a new master event on its first sync via `handleRoutinePush`.
    const tail: RoutineInterface = {
        _id: randomUUID(),
        user: head.user,
        title: edits.title ?? head.title,
        routineType: edits.routineType ?? head.routineType,
        rrule: edits.rrule ?? head.rrule,
        template: edits.template ?? head.template,
        active: edits.active ?? true,
        splitFromRoutineId: head._id,
        createdTs: dayjs.utc(params.splitDate).startOf('day').toISOString(),
        updatedTs: now,
        ...((edits.calendarItemTemplate ?? head.calendarItemTemplate) ? { calendarItemTemplate: edits.calendarItemTemplate ?? head.calendarItemTemplate } : {}),
        ...(head.calendarIntegrationId ? { calendarIntegrationId: head.calendarIntegrationId } : {}),
        ...(head.calendarSyncConfigId ? { calendarSyncConfigId: head.calendarSyncConfigId } : {}),
        ...(edits.startDate ? { startDate: edits.startDate } : {}),
        // recurrenceAnchor is only meaningful for nextAction routines — never carry it onto a
        // calendar-type tail (RoutineSnapshotSchema rejects it there).
        ...((edits.recurrenceAnchor ?? head.recurrenceAnchor) && (edits.routineType ?? head.routineType) === 'nextAction'
            ? { recurrenceAnchor: edits.recurrenceAnchor ?? head.recurrenceAnchor }
            : {}),
    };
    return tail;
}

async function updateRoutine(
    ctx: CompositeContext,
    routine: RoutineInterface,
    patch: Partial<RoutineInterface>,
    now: string,
): Promise<{ ok: true; routine: RoutineInterface }> {
    const snapshot: RoutineInterface = { ...routine, ...patch, updatedTs: now };
    await applyAndPublishOperation(
        ctx.userId,
        { entityType: 'routine', opType: 'update', entityId: routine._id, snapshot },
        { deviceId: `api:${ctx.tokenId}`, now, strict: true },
    );
    return { ok: true, routine: snapshot };
}
