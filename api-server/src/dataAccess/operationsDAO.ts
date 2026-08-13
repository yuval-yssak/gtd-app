import type { FindCursor, MongoClient, WithId } from 'mongodb';
import type { PurgeFloor } from '../lib/purgeFloor.js';
import { stableStringify } from '../lib/stableStringify.js';
import type { OperationInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

type DedupCandidate = Pick<OperationInterface, '_id' | 'entityId' | 'opType' | 'snapshot'>;

/**
 * Walks a cursor of ops sorted by `(entityId, ts, _id)` and collects the `_id`s of ops whose snapshot
 * is byte-identical (stable deep-equal) to the immediately-preceding KEPT op for the same entity. The
 * per-entity latest op is always kept, and 'delete' and 'rsvp' ops are always kept. Only the
 * previous-kept snapshot string per entity is held in memory, so this scales to large collections.
 */
async function collapseConsecutiveIdenticalSnapshots(cursor: FindCursor<WithId<DedupCandidate>>): Promise<{ deletableIds: string[]; scannedEntities: number }> {
    const deletableIds: string[] = [];
    const entityIds = new Set<string>();
    let currentEntityId: string | null = null;
    let prevKeptSnapshot: string | null = null;
    // The previous op for this entity that we tentatively decided to delete (a duplicate of the kept
    // anchor). Held back one step so we never delete the entity's latest op: if no further op follows,
    // this stays kept; if another op follows, it's safe to flush as deletable.
    let heldDeletableId: string | null = null;

    function flushHeld() {
        if (heldDeletableId !== null) {
            deletableIds.push(heldDeletableId);
            heldDeletableId = null;
        }
    }

    for await (const op of cursor) {
        if (op.entityId !== currentEntityId) {
            // New entity: the held op from the previous entity was that entity's latest → keep it.
            heldDeletableId = null;
            currentEntityId = op.entityId;
            entityIds.add(op.entityId);
            prevKeptSnapshot = null;
        }
        // 'rsvp' ops persist with snapshot null (applyOperation.ts) but are NOT idempotent snapshot
        // replacements — they drive events.patch via replay, so two consecutive rsvp ops must never
        // collapse. Treat them like 'delete': null key (never a redundant duplicate, resets the anchor).
        const snapshotKey = op.opType === 'delete' || op.opType === 'rsvp' ? null : stableStringify(op.snapshot);
        // A 'delete'/'rsvp' op (null key) is never a redundant duplicate. Keep it, flush any held
        // duplicate (it's no longer the latest), and reset the anchor so a later identical create/update
        // isn't compared against a pre-delete snapshot.
        if (snapshotKey !== null && snapshotKey === prevKeptSnapshot) {
            // Duplicate of the kept anchor: a previously-held duplicate (if any) is now superseded.
            flushHeld();
            heldDeletableId = op._id;
        } else {
            // Distinct snapshot (or a delete): becomes the new kept anchor. Any held duplicate is
            // superseded by this newer op, so it's safe to delete.
            flushHeld();
            prevKeptSnapshot = snapshotKey;
        }
    }
    return { deletableIds, scannedEntities: entityIds.size };
}

class OperationsDAO extends AbstractDAO<OperationInterface> {
    override COLLECTION_NAME = 'operations';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        await this._collection.createIndexes([
            // Compound (ts, _id) so incremental pull paginates on the totally-ordered pair, not a
            // bare millisecond — a same-`ts` batch can't be split across two pulls and lose ops.
            { key: { user: 1, ts: 1, _id: 1 } },
            // Kept (now a strict prefix of the compound index): dropping costs more operational risk
            // than the redundant index saves on this low-throughput workload.
            { key: { user: 1, ts: 1 } }, // incremental pull: all ops for user since a given ts
            { key: { user: 1, entityType: 1, entityId: 1, ts: 1 } }, // entity history lookup
        ]);
    }

    /**
     * Incremental-pull query on the compound cursor `(since, sinceId)`: returns ops strictly greater
     * than that pair under `(ts, _id)` ordering. MongoDB has no native tuple `$gt`, so we express it
     * as an `$or` of "newer ms" plus "same ms, higher id". The same-ms clause MUST be `$gt` (not
     * `$gte`) — `$gte` would re-emit the cursor op every pull, an endless re-delivery loop.
     * A missing/empty `sinceId` ('' sorts below every id) degrades to `$gte since` semantics, which
     * re-checks the whole boundary ms — safe (applies are idempotent) and strictly better than the
     * old `$gt ts` that skipped it.
     */
    async findOpsAfter(userId: string, since: string, sinceId: string): Promise<OperationInterface[]> {
        // `notApplied` quarantine: ops whose apply was skipped (target row gone — deleted or
        // reassigned away) are never delivered; replaying them would resurrect the entity
        // client-side. They stay in the collection for audit + the SyncIssuesPanel.
        return await this.findArray(
            { user: userId, notApplied: { $exists: false }, $or: [{ ts: { $gt: since } }, { ts: since, _id: { $gt: sinceId } } as never] },
            { sort: { ts: 1, _id: 1 } },
        );
    }

    /**
     * Count-only sibling of `findOpsAfter` — the same compound-cursor predicate without materializing
     * ops. Backs the connected-devices list's per-device "operations behind" figure.
     */
    async countOpsAfter(userId: string, since: string, sinceId: string): Promise<number> {
        // Mirrors findOpsAfter's notApplied quarantine so the "operations behind" figure counts
        // only ops the device will actually receive.
        return await this.countDocuments({
            user: userId,
            notApplied: { $exists: false },
            $or: [{ ts: { $gt: since } }, { ts: since, _id: { $gt: sinceId } } as never],
        });
    }

    async deleteOlderThan(userId: string, minTs: string, minId: string): Promise<number> {
        // Delete only ops at-or-below the compound floor `(minTs, minId)` — the exact position the
        // slowest device has provably received. The same-ms clause MUST be `_id: { $lte: minId }`,
        // NOT `ts: { $lte: minTs }`: a bare `$lte ts` would delete same-ms ops *past* the slowest
        // device's acked position that it hasn't pulled yet, the purge-side dual of the pull bug.
        // Deliberately does NOT exclude `notApplied`/`syncFailed` rows: once the floor passes a
        // quarantined op it is purged and drops off /sync/issues — matching the pre-existing
        // lifecycle for all failed ops (the panel is a recent-failures surface, not an archive).
        const result = await this._collection.deleteMany({
            user: userId,
            $or: [{ ts: { $lt: minTs } }, { ts: minTs, _id: { $lte: minId } }],
        } as never);
        return result.deletedCount;
    }

    /**
     * Streams a user's ops at-or-below the compound floor `(floorTs, floorId)`, grouped by entityId in
     * `(ts, _id)` order, and returns the `_id`s of ops whose `snapshot` is byte-identical (stable
     * deep-equal) to the immediately-preceding kept op for that entity. Used by /maintenance/dedup to
     * collapse the perpetual-no-op-update bloat (calendar-webhook fires rewriting identical snapshots).
     *
     * Never returns: any 'delete' or 'rsvp' op (snapshot semantics differ — null vs. a real snapshot,
     * and rsvp ops are not idempotent snapshot replacements), or the per-entity latest kept op
     * (last-write-wins anchor must survive). Ops ABOVE the floor are out of
     * scope here — they may still be in-flight to a device. Iterates a cursor rather than loading the
     * whole collection into memory; only the per-entity "previous kept snapshot" string is retained.
     */
    async findRedundantOpIdsBelowFloor(userId: string, floor: PurgeFloor): Promise<{ deletableIds: string[]; scannedEntities: number }> {
        // Same compound-floor predicate as deleteOlderThan, but grouped per entity. Sort by
        // (entityId, ts, _id) so each entity's ops arrive contiguously in totally-ordered sequence.
        const cursor = this._collection.find({ user: userId, $or: [{ ts: { $lt: floor.ts } }, { ts: floor.ts, _id: { $lte: floor.id } }] } as never, {
            sort: { entityId: 1, ts: 1, _id: 1 },
            projection: { _id: 1, entityId: 1, opType: 1, snapshot: 1 },
        });
        return await collapseConsecutiveIdenticalSnapshots(cursor);
    }

    /**
     * Owner-scoped bulk delete by `_id`. Returns the deletedCount so the dedup endpoint can report how
     * many redundant ops it removed. Scoped by `user` so a caller can only ever delete its own ops.
     */
    async deleteByIds(opIds: string[], userId: string): Promise<number> {
        if (!opIds.length) {
            return 0;
        }
        const result = await this._collection.deleteMany({ _id: { $in: opIds }, user: userId } as never);
        return result.deletedCount;
    }

    /**
     * Owner-scoped single-op delete. Returns the result so callers (e.g. /sync/issues/:opId/dismiss)
     * can branch on `deletedCount === 0` to surface a 404 instead of pretending the op was removed.
     * Distinct from `deleteByOwner` (void-returning) on AbstractDAO since the panel handler needs
     * to discriminate "not found" from "deleted" to keep the UX honest.
     */
    async deleteOne(opId: string, userId: string) {
        return await this._collection.deleteOne({ _id: opId, user: userId } as never);
    }
}

export default new OperationsDAO();
