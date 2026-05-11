import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import type { ItemInterface, RoutineInterface } from '../types/entities.js';
import { applyAndPublishOperation } from './applyOperation.js';
import { computeNextOccurrence, RruleExhaustedError } from './rruleHelpers.js';

dayjs.extend(utc);

/**
 * Server-side mirror of `client/src/db/routineItemHelpers.ts`'s nextAction-routine generators.
 * Provides the two entry points the public API needs:
 *   - `ensureFirstRoutineItem` — used by POST /v1/routines (create) and resumeRoutine.
 *   - `advanceRoutineAfterDisposal` — used by POST /v1/items/:id/complete and the trash transition.
 *
 * Both are idempotent in spirit:
 *   - `ensureFirstRoutineItem` no-ops when an open item already exists for the routine.
 *   - `advanceRoutineAfterDisposal` simply creates the next-occurrence item; the caller is expected
 *     to invoke it once per disposal (the disposal handlers in routes/v1/items.ts do this).
 *
 * Failure semantics mirror the client (`itemMutations.ts:maybeCreateNextRoutineItem`):
 *   - `RruleExhaustedError` → deactivate the routine (the series is over).
 *   - Anything else → log and continue. Item-generation must never fail the parent request.
 *
 * Calendar routines are intentionally NOT handled here — their horizon-based generation reads the
 * full items collection and lives in `routineItemRegeneration.ts` (GCal-driven) and the client.
 */

export interface RoutineItemGenerationContext {
    userId: string;
    tokenId: string;
}

/**
 * Construct a server-side snapshot for a routine-generated nextAction item. Field shape mirrors
 * `persistRoutineItem` in the client helpers so server- and client-generated items are
 * indistinguishable when they round-trip through sync.
 */
export function buildRoutineItemSnapshot(routine: RoutineInterface, expectedBy: string, now: string): ItemInterface {
    return {
        _id: randomUUID(),
        user: routine.user,
        status: 'nextAction',
        title: routine.title,
        routineId: routine._id,
        expectedBy,
        // Routine-generated items are hidden until their due date (tickler pattern).
        ignoreBefore: expectedBy,
        ...(routine.template.workContextIds ? { workContextIds: routine.template.workContextIds } : {}),
        ...(routine.template.peopleIds ? { peopleIds: routine.template.peopleIds } : {}),
        ...(routine.template.energy ? { energy: routine.template.energy } : {}),
        ...(routine.template.time !== undefined ? { time: routine.template.time } : {}),
        ...(routine.template.focus !== undefined ? { focus: routine.template.focus } : {}),
        ...(routine.template.urgent !== undefined ? { urgent: routine.template.urgent } : {}),
        ...(routine.template.notes ? { notes: routine.template.notes } : {}),
        createdTs: now,
        updatedTs: now,
    };
}

/**
 * Materialize the first nextAction item for a freshly created or resumed routine. No-op when:
 *   - routineType is not 'nextAction' (calendar routines use the horizon-based generator);
 *   - the routine is inactive; or
 *   - an open (non-done/non-trash) item already exists for the routine — preserves the "at most
 *     one open item" invariant when called against an already-bootstrapped routine.
 *
 * Anchors at UTC-midnight of `max(today, routine.startDate)` and uses `includeAnchor=true` so a
 * daily/interval rule lands on the anchor itself rather than skipping to tomorrow.
 *
 * Errors:
 *   - `RruleExhaustedError` — the rrule has no future occurrence; deactivates the routine.
 *   - Anything else — logs and swallows. The parent request (POST /routines / resumeRoutine) must
 *     not fail because the item generator hit a snag.
 */
export async function ensureFirstRoutineItem(ctx: RoutineItemGenerationContext, routine: RoutineInterface): Promise<void> {
    if (routine.routineType !== 'nextAction' || !routine.active) {
        return;
    }
    if (await hasOpenItem(ctx.userId, routine._id)) {
        return;
    }
    const anchor = computeFirstAnchor(routine.startDate);
    try {
        const next = computeNextOccurrence(routine.rrule, anchor, true);
        const expectedBy = dayjs.utc(next).format('YYYY-MM-DD');
        await publishRoutineItem(ctx, routine, expectedBy);
    } catch (err) {
        await handleGenerationError(ctx, routine, err, 'ensureFirstRoutineItem');
    }
}

/**
 * Advance a nextAction routine after one of its items was disposed (completed or trashed). No-op
 * when the routine is not a nextAction routine or is inactive — the caller checks both already,
 * but this guard keeps the contract symmetric with `ensureFirstRoutineItem`.
 *
 * Anchors at `max(disposalDate, routine.startDate)` and uses `includeAnchor=false` (strict-after)
 * so a same-day disposal advances to the next occurrence — same semantics as the client's
 * `createNextRoutineItem`.
 */
export async function advanceRoutineAfterDisposal(ctx: RoutineItemGenerationContext, routine: RoutineInterface, disposalDate: Date): Promise<void> {
    if (routine.routineType !== 'nextAction' || !routine.active) {
        return;
    }
    const anchor = computeDisposalAnchor(disposalDate, routine.startDate);
    try {
        const next = computeNextOccurrence(routine.rrule, anchor, false);
        const expectedBy = dayjs.utc(next).format('YYYY-MM-DD');
        await publishRoutineItem(ctx, routine, expectedBy);
    } catch (err) {
        await handleGenerationError(ctx, routine, err, 'advanceRoutineAfterDisposal');
    }
}

/**
 * The first-item anchor: UTC-midnight of `max(today, routine.startDate)`. Constructed on the
 * user's local calendar date — see `createFirstRoutineItem` in the client helpers for the
 * timezone reasoning. Without a startDate, anchor at today.
 */
function computeFirstAnchor(startDate: string | undefined): Date {
    const todayAsUtcDay = dayjs.utc(dayjs().format('YYYY-MM-DD')).toDate();
    if (!startDate) {
        return todayAsUtcDay;
    }
    const startAsUtcDay = dayjs.utc(startDate).toDate();
    return startAsUtcDay > todayAsUtcDay ? startAsUtcDay : todayAsUtcDay;
}

/**
 * The disposal anchor: `max(disposalDate, routine.startDate)`. Mirrors `createNextRoutineItem` —
 * a future-start-date routine never produces an item with expectedBy before its startDate, even
 * when an earlier-generated item is disposed of before that date.
 */
function computeDisposalAnchor(disposalDate: Date, startDate: string | undefined): Date {
    if (!startDate) {
        return disposalDate;
    }
    const startAsUtc = dayjs.utc(startDate).toDate();
    return startAsUtc > disposalDate ? startAsUtc : disposalDate;
}

/**
 * Persist a fresh nextAction item snapshot through the shared apply pipeline so the op log + SSE
 * + web push + webhook fan-out cover this server-side generation. `deviceId: api:<tokenId>` matches
 * the convention every other public-API write uses.
 */
async function publishRoutineItem(ctx: RoutineItemGenerationContext, routine: RoutineInterface, expectedBy: string): Promise<void> {
    const now = dayjs().toISOString();
    const snapshot = buildRoutineItemSnapshot(routine, expectedBy, now);
    await applyAndPublishOperation(
        ctx.userId,
        { entityType: 'item', opType: 'create', entityId: snapshot._id ?? '', snapshot },
        { deviceId: `api:${ctx.tokenId}`, now },
    );
}

/**
 * Distinguish exhaustion (deactivate the routine) from any other error (log and continue). When
 * the deactivation itself throws, log it — never let a failed deactivation cascade up.
 */
async function handleGenerationError(ctx: RoutineItemGenerationContext, routine: RoutineInterface, err: unknown, callerLabel: string): Promise<void> {
    if (err instanceof RruleExhaustedError) {
        await deactivateRoutine(ctx, routine).catch((deactivateErr) => {
            console.error('[routine] failed to deactivate exhausted routine', { routineId: routine._id, callerLabel, err: deactivateErr });
        });
        return;
    }
    console.error('[routine] failed to create routine item', { routineId: routine._id, callerLabel, err });
}

/** Flip the routine to inactive when its series is exhausted. Goes through the apply pipeline. */
async function deactivateRoutine(ctx: RoutineItemGenerationContext, routine: RoutineInterface): Promise<void> {
    const now = dayjs().toISOString();
    const snapshot: RoutineInterface = { ...routine, active: false, updatedTs: now };
    await applyAndPublishOperation(
        ctx.userId,
        { entityType: 'routine', opType: 'update', entityId: routine._id, snapshot },
        { deviceId: `api:${ctx.tokenId}`, now },
    );
}

/** True when the routine already has a non-done/non-trash item — preserves "at most one open item". */
async function hasOpenItem(userId: string, routineId: string): Promise<boolean> {
    const open = await itemsDAO.findOne({ user: userId, routineId, status: { $nin: ['done', 'trash'] } } as never);
    return open !== null;
}
