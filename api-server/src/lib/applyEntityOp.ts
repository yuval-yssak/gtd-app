import type AbstractDAO from '../dataAccess/abstractDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import peopleDAO from '../dataAccess/peopleDAO.js';
import reviewInboxesDAO from '../dataAccess/reviewInboxesDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import workContextsDAO from '../dataAccess/workContextsDAO.js';
import {
    type EntitySnapshot,
    type EntityType,
    type ItemInterface,
    ItemStatus,
    type OperationInterface,
    type OpType,
    type PersonInterface,
    type ReviewInboxInterface,
    type RoutineInterface,
    type WorkContextInterface,
} from '../types/entities.js';

/**
 * What happened to an op inside `applyEntityOp`. Callers use this to decide the fan-out:
 *   - 'applied' — the collection changed (or the op had no collection-side effect by design,
 *     e.g. rsvp ops with snapshot:null); notify + cascades proceed as usual.
 *   - 'skipped_missing' — an update whose target row is gone (deleted or superseded). The op must
 *     be QUARANTINED (marked notApplied + excluded from pull/notify) — replaying it to other
 *     devices would resurrect an entity the server intentionally removed (e.g. an offline edit
 *     racing a cross-account reassign that already moved the entity away).
 *   - 'skipped_stale' — lost last-write-wins to a newer row; harmless to replay (other devices'
 *     LWW will skip it too).
 *   - 'skipped_duplicate_key' — the snapshot claims a unique key owned by another row; can never
 *     apply, treated as superseded.
 */
export type ApplyEntityOpOutcome = 'applied' | 'skipped_missing' | 'skipped_stale' | 'skipped_duplicate_key';

/**
 * The one LWW rule, named: the incoming snapshot wins when its `updatedTs` is newer than — or
 * TIED with — the stored row's (ISO-string compare). Tie → incoming wins ("last arriver"), which
 * is deterministic across devices because every device replays the same totally-ordered
 * `(ts, _id)` op log (compound pull cursor) — server row and every replica converge on the final
 * op of the tie group. A content-level deterministic tie-break independent of arrival order
 * would need a persisted per-row op watermark (entity field + client IDB schema) — an explicit
 * follow-up, out of scope here. Mirrored client-side in `client/src/db/syncHelpers.ts`
 * (`incomingWinsLww`); change both together.
 */
export function incomingWinsLww(existingUpdatedTs: string, incomingUpdatedTs: string): boolean {
    return existingUpdatedTs <= incomingUpdatedTs;
}

/**
 * Persists a single op to its target collection. Last-write-wins on (updatedTs); deletes are
 * scoped by user to ensure a crafted op can't reach across users.
 *
 * Lifted out of `routes/sync.ts` so the new `applyAndPublishOperation` pipeline can drive both
 * `/sync/push` and `/v1/*` writes through the same primitive.
 */
async function applyEntitySnapshotOp<T extends EntitySnapshot>(
    dao: AbstractDAO<T>,
    userId: string,
    entityId: string,
    opType: OpType,
    snapshot: T | null,
): Promise<ApplyEntityOpOutcome> {
    if (opType === 'delete') {
        await dao.deleteByOwner(entityId, userId);
        return 'applied';
    }
    if (!snapshot) {
        return 'applied';
    }
    const existing = await dao.findByOwnerAndId(entityId, userId);
    // An update whose target row is gone means the entity was deleted (or superseded — e.g. a
    // routine regeneration replaced its items, or a cross-account reassign moved it away) after
    // the client queued the op. Letting `replaceById`'s upsert resurrect it reintroduces a row
    // the server intentionally removed, and when a successor row holds the same unique key
    // (user + calendarInstanceEventId) the upsert-insert throws E11000 — permanently jamming the
    // client's push queue (the 2026-08-03 stuck-sync incident). Deletion wins: skip the op and
    // report 'skipped_missing' so the pipeline quarantines it from the pull/notify fan-out
    // (other source-user devices replaying it would resurrect the entity client-side).
    if (!existing && opType === 'update') {
        console.warn(`[apply-op] skipped update for missing ${entityId}: deleted or superseded; not resurrecting`);
        return 'skipped_missing';
    }
    if (!existing || incomingWinsLww(existing.updatedTs, snapshot.updatedTs)) {
        try {
            await dao.replaceById(entityId, snapshot);
        } catch (err) {
            // Duplicate unique key: the snapshot claims a key (e.g. user+calendarInstanceEventId)
            // that a DIFFERENT row now owns, so this op can never apply — treat it as superseded
            // instead of failing the whole batch and wedging the client's retry loop.
            if (isDuplicateKeyError(err)) {
                console.warn(`[apply-op] skipped unappliable ${opType} for ${entityId}: unique key owned by another row`, err);
                return 'skipped_duplicate_key';
            }
            throw err;
        }
        return 'applied';
    }
    return 'skipped_stale';
}

/** MongoServerError E11000 — unique index violation. */
export function isDuplicateKeyError(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

export function applyEntityOp(userId: string, op: OperationInterface): Promise<ApplyEntityOpOutcome> {
    const { entityType, entityId, opType, snapshot } = op;
    switch (entityType) {
        case 'item':
            return applyEntitySnapshotOp(itemsDAO, userId, entityId, opType, snapshot as ItemInterface | null);
        case 'routine':
            return applyEntitySnapshotOp(routinesDAO, userId, entityId, opType, snapshot as RoutineInterface | null);
        case 'person':
            return applyEntitySnapshotOp(peopleDAO, userId, entityId, opType, snapshot as PersonInterface | null);
        case 'workContext':
            return applyEntitySnapshotOp(workContextsDAO, userId, entityId, opType, snapshot as WorkContextInterface | null);
        case 'reviewInbox':
            return applyEntitySnapshotOp(reviewInboxesDAO, userId, entityId, opType, snapshot as ReviewInboxInterface | null);
    }
}

/**
 * Delete ops ship with `snapshot: null` over the wire (the entity is going away — there's no
 * meaningful post-delete state). But downstream fan-out — GCal pushback, person/workContext
 * reference cascades — needs the pre-delete state to know which GCal event to cancel, which
 * person name to record in a breadcrumb, etc.
 *
 * Hydrates `op.snapshot` in-place by reading the row from its collection before `applyEntityOp`
 * hard-deletes it. MUST run before persistence — otherwise the lookup races and returns null.
 *
 * No-ops for ops that already carry a snapshot (e.g. the client occasionally sends one for
 * audit-trail reasons), and for delete ops whose row was already gone (another device deleted
 * concurrently; the cascade for that op will no-op gracefully).
 */
export async function hydrateDeleteSnapshots(userId: string, ops: OperationInterface[]): Promise<void> {
    const targets = ops.filter((op) => op.opType === 'delete' && !op.snapshot);
    if (!targets.length) {
        return;
    }
    await Promise.all(targets.map((op) => hydrateOne(userId, op)));
}

/**
 * Statuses whose GTD semantics are "this is no longer a scheduled event" — transitioning a
 * calendar item to one of these must remove its Google Calendar presence. `done` and `trash`
 * are intentionally absent: `done` keeps the event with a ✓ marker (matrix A8) and `trash`
 * keeps `calendarEventId` on the snapshot, so the existing pushback branches handle both.
 */
const CALENDAR_DETACH_STATUSES: ReadonlySet<ItemStatus> = new Set([ItemStatus.inbox, ItemStatus.nextAction, ItemStatus.waitingFor, ItemStatus.somedayMaybe]);

/**
 * Clients strip `calendarEventId`/`timeStart` off the snapshot when clarifying a calendar item
 * to an active non-calendar status (the status→field matrix forbids them there), so the op that
 * reaches pushback carries no evidence of the GCal event that must now be removed. This hydrator
 * captures the pre-update row onto `op.detachedCalendar` while it still exists — it MUST run
 * before `applyEntityOp` overwrites the row. Pushback then deletes the linked event (or cancels
 * the routine occurrence) from that sidecar.
 */
export async function hydrateCalendarDetachSnapshots(userId: string, ops: OperationInterface[]): Promise<void> {
    const targets = ops.filter(isCalendarDetachCandidate);
    if (!targets.length) {
        return;
    }
    await Promise.all(targets.map((op) => hydrateDetachOne(userId, op)));
}

function isCalendarDetachCandidate(op: OperationInterface): boolean {
    if (op.entityType !== 'item' || op.opType !== 'update' || !op.snapshot) {
        return false;
    }
    return CALENDAR_DETACH_STATUSES.has((op.snapshot as ItemInterface).status);
}

async function hydrateDetachOne(userId: string, op: OperationInterface): Promise<void> {
    const incoming = op.snapshot as ItemInterface;
    const existing = (await itemsDAO.findByOwnerAndId(op.entityId, userId)) as ItemInterface | null;
    if (!existing || existing.status !== ItemStatus.calendar) {
        return;
    }
    // Mirror the LWW gate in applyEntitySnapshotOp: a stale op that will not replace the row
    // must not cancel the GCal event of the (newer) state that stays in place.
    if (!incomingWinsLww(existing.updatedTs, incoming.updatedTs)) {
        return;
    }
    const hasGCalPresence = Boolean(existing.calendarEventId) || Boolean(existing.routineId && existing.timeStart);
    if (!hasGCalPresence) {
        return;
    }
    op.detachedCalendar = existing;
}

async function hydrateOne(userId: string, op: OperationInterface): Promise<void> {
    const lookup = pickHydrationLookup(op.entityType);
    if (!lookup) {
        return;
    }
    const snapshot = await lookup(op.entityId, userId);
    if (snapshot) {
        op.snapshot = snapshot;
        return;
    }
    console.warn(`[apply-op] ${op.entityType} ${op.entityId} already deleted — snapshot hydration skipped, cascade will no-op`);
}

// Narrow the DAO surface to just the one method the hydrator needs. `AbstractDAO<T>` is
// invariant in T, so reusing the parent generic to switch concrete DAOs would require an
// unsound cast — exposing just the lookup method sidesteps the variance issue entirely.
type HydrationLookup = (entityId: string, userId: string) => Promise<EntitySnapshot | null>;

function pickHydrationLookup(entityType: EntityType): HydrationLookup | null {
    switch (entityType) {
        case 'item':
            return (id, uid) => itemsDAO.findByOwnerAndId(id, uid);
        case 'routine':
            return (id, uid) => routinesDAO.findByOwnerAndId(id, uid);
        case 'person':
            return (id, uid) => peopleDAO.findByOwnerAndId(id, uid);
        case 'workContext':
            return (id, uid) => workContextsDAO.findByOwnerAndId(id, uid);
        case 'reviewInbox':
            return (id, uid) => reviewInboxesDAO.findByOwnerAndId(id, uid);
    }
}
