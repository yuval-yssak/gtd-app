import type { Collection, Document, MongoClient, OptionalUnlessRequiredId, UpdateFilter } from 'mongodb';
import {
    BRIEF_STALE_FILTER,
    type BriefSourceGuard,
    briefSourceGuardFilter,
    type ItemBulkOperation,
    markBriefStaleOnBulkOperation,
    markBriefStaleOnDocument,
    SETTLE_BRIEF_STALE,
    type SettledBriefItem,
    withBriefStaleMark,
} from '../lib/brief/briefStaleMarker.js';
import type { ItemInterface } from '../types/entities.js';
import AbstractDAO from './abstractDAO.js';

class ItemsDAO extends AbstractDAO<ItemInterface> {
    override COLLECTION_NAME = 'items';

    override async init(client: MongoClient, dbName: string) {
        await super.init(client, dbName);
        await this._collection.createIndexes([
            { key: { user: 1 } },
            { key: { user: 1, status: 1 } },
            { key: { user: 1, expectedBy: 1 } },
            { key: { user: 1, timeStart: 1 } },
            { key: { user: 1, updatedTs: 1 } }, // used by sync: pull all items changed since last device sync
            // Public API dedupe: external integrations may upsert by externalId.
            // Sparse + partial: only items that actually carry an externalId participate; in-app
            // items have no externalId and must not collide with each other.
            { key: { user: 1, externalId: 1 }, unique: true, partialFilterExpression: { externalId: { $type: 'string' } } },
            // Calendar exception race guard: two concurrent inbound paths (manual sync racing a
            // webhook delivery) can each see `resolveExceptionTarget` miss and both try to
            // create-on-miss for the same instance. The unique partial index forces the loser to
            // E11000 so `createItemForOrphanedException` can re-resolve and converge instead of
            // inserting a duplicate row. Only items carrying a string `calendarInstanceEventId`
            // participate — in-app items never set the field and must not collide.
            { key: { user: 1, calendarInstanceEventId: 1 }, unique: true, partialFilterExpression: { calendarInstanceEventId: { $type: 'string' } } },
            // Public API content-dedupe: lookup is { user, status:'inbox', contentHash, createdTs >= cutoff }.
            { key: { user: 1, status: 1, contentHash: 1, createdTs: 1 } },
            // Reference-cascade scans: when a person/workContext is deleted, the cascade in
            // `lib/referenceCascades.ts` queries items by `{user, peopleIds: id}` / `{user,
            // workContextIds: id}` / `{user, waitingForPersonId: id}`. The first two are
            // multikey indexes (arrays); the third is a sparse scalar lookup.
            { key: { user: 1, peopleIds: 1 } },
            { key: { user: 1, workContextIds: 1 } },
            { key: { user: 1, waitingForPersonId: 1 } },
            // Brief-sweep selection: `{ user, briefStale, status }` partial on `briefStale: true`.
            // Partial because the steady state is "nothing stale" — the index then holds zero keys
            // and costs nothing, instead of one key per item (settled rows carry `briefStale: false`
            // and are excluded by the partial filter). `status` is the third component so the
            // open-statuses-only restriction is an index BOUND, not a fetched residual: on the
            // staging corpus that keeps 90 % of items (done/trash) off the read path entirely.
            {
                key: { user: 1, briefStale: 1, status: 1 },
                partialFilterExpression: { briefStale: true },
                name: 'brief_stale_targets',
            },
        ]);
    }

    /**
     * ── `briefStale` choke point ──────────────────────────────────────────────────────────────
     * Every write below re-stamps the marker so the brief sweep never has to walk the collection
     * (`lib/brief/briefStaleMarker.ts`). These overrides exist because item writes are spread over
     * ~40 call sites — /sync/push, the /v1 routes, GCal inbound sync, the routine generator, the
     * reference cascades, reassign and the one-off scripts — and a marker maintained at those call
     * sites would silently rot the first time one was added without it. Maintaining it HERE makes
     * it structurally unbypassable for anything that goes through the DAO.
     *
     * Full-document writes are marked unconditionally; partial updates only when their payload can
     * move `title`, `notes` or `status`. Both are conservative: the marker decides what the sweep
     * LOOKS at, and the hash comparison that decides what it WRITES stays in `briefWriter`'s
     * compare-and-set.
     *
     * ⚠️ The two escape hatches are `initializeUnorderedBulkOp()` and the raw `collection` getter,
     * both inherited from `AbstractDAO` and neither used for items today. A write through either
     * would silently skip the marker, leaving the item permanently invisible to the sweep — mark it
     * yourself with `markBriefStaleOnDocument` / `withBriefStaleMark`, or add an override here.
     */

    override async insertOne(doc: OptionalUnlessRequiredId<ItemInterface>, options?: Parameters<Collection<ItemInterface>['insertOne']>[1]) {
        return super.insertOne(markBriefStaleOnDocument(doc), options);
    }

    override async insertMany(docs: OptionalUnlessRequiredId<ItemInterface>[], options?: Parameters<Collection<ItemInterface>['insertMany']>[1]) {
        return super.insertMany(docs.map(markBriefStaleOnDocument), options);
    }

    override async replaceById(entityId: string, doc: ItemInterface): Promise<void> {
        await super.replaceById(entityId, markBriefStaleOnDocument(doc));
    }

    override async replaceByOwner(entityId: string, ownerId: string, doc: ItemInterface): Promise<number> {
        return super.replaceByOwner(entityId, ownerId, markBriefStaleOnDocument(doc));
    }

    override async updateOne(
        filter: Parameters<AbstractDAO<ItemInterface>['updateOne']>[0],
        update: UpdateFilter<ItemInterface> | Document[],
        updateOptions?: Parameters<Collection<ItemInterface>['updateOne']>[2],
    ) {
        return super.updateOne(filter, withBriefStaleMark(update) as never, updateOptions);
    }

    override async updateMany(
        filter: Parameters<AbstractDAO<ItemInterface>['updateMany']>[0],
        update: UpdateFilter<ItemInterface> | Document[],
        updateOptions?: Parameters<Collection<ItemInterface>['updateMany']>[2],
    ) {
        return super.updateMany(filter, withBriefStaleMark(update) as never, updateOptions);
    }

    /**
     * `bulkWrite` carries its own per-operation update payloads, so it bypasses the `updateOne` /
     * `updateMany` overrides entirely. Marking each operation keeps the one production caller
     * (`scripts/importFacileThings.ts`, which upserts title + notes) honest, and any future one.
     */
    override async bulkWrite(operations: ItemBulkOperation[], options?: Parameters<Collection<ItemInterface>['bulkWrite']>[1]) {
        return super.bulkWrite(operations.map(markBriefStaleOnBulkOperation), options);
    }

    /**
     * Puts an item back into the sweep's candidate set WITHOUT touching its content.
     *
     * The write-path overrides above cover everything that changes an `items` document, but the
     * marker answers "does this item need a brief?" — a question the `itemBriefs` SIDECAR can also
     * change on its own. Deleting or authoring a brief row leaves the item untouched, so the choke
     * point never sees it; `lib/itemBriefs.ts` calls this instead. Unguarded and unconditional:
     * re-marking is always the safe direction.
     */
    async markBriefStale(entityId: string, userId: string): Promise<void> {
        await super.updateOne({ _id: entityId, user: userId } as never, { $set: { briefStale: true } } as never);
    }

    /**
     * Settles the marker once a brief row has been recorded against this item's CURRENT content.
     *
     * Guarded on the CONTENT the decision was made from, not merely on `updatedTs`. Every
     * production write that moves `title`/`notes`/`status` also bumps `updatedTs`, so a timestamp
     * guard would pass today — but it is a proxy for the thing that actually matters, and one write
     * that forgets the bump would silently settle an item against content its brief does not
     * describe, stranding it with no marker to bring it back. Comparing the fields themselves
     * cannot be defeated that way. Losing the race leaves the marker set: one more sweep pass,
     * which is the safe direction.
     *
     * Calls `super` so the `updateOne` override does not re-mark what this is settling.
     */
    async clearBriefStale(entityId: string, userId: string, source: BriefSourceGuard): Promise<void> {
        await super.updateOne({ _id: entityId, user: userId, ...briefSourceGuardFilter(source) } as never, SETTLE_BRIEF_STALE as never);
    }

    /**
     * Settles the marker on items the sweep examined and found already current (false positives
     * from the deliberately conservative marking rule).
     *
     * Guarded per row on the same content anchor as `clearBriefStale`, and NOT because the DAO
     * override would re-mark: the sweep reads a page, then round-trips to `itemBriefs` and hashes
     * it in Node before getting here, so a `/sync/push` flush or a GCal webhook landing in that
     * window would have its fresh mark erased by an unguarded settle — leaving current content with
     * a stale brief and nothing to bring it back.
     */
    async clearBriefStaleBatch(userId: string, settled: SettledBriefItem[]): Promise<void> {
        if (settled.length === 0) {
            return;
        }
        const rows = settled.map(({ _id, ...source }) => ({ _id, ...briefSourceGuardFilter(source) }));
        await super.updateMany({ user: userId, $or: rows } as never, SETTLE_BRIEF_STALE as never);
    }

    /**
     * Server-side "mark every item the marker has never seen" — the backfill's only write
     * (`lib/brief/briefStaleBackfill.ts`). Both filter and update are evaluated inside Mongo, so a
     * 12 000-item corpus is repaired without a document crossing the wire.
     *
     * CONVERGENT, not merely idempotent-per-run: `$exists: false` matches only items written before
     * the marker existed, because settling writes `briefStale: false` rather than removing the
     * field. That distinction is load-bearing — Cloud Run scales to zero and re-runs this on every
     * cold start, so an `$exists`-based filter that also matched the settled state would re-mark
     * the whole collection several times a day and permanently undo the fix this is part of.
     */
    async markUnmarkedItemsStale(): Promise<number> {
        const result = await super.updateMany({ briefStale: { $exists: false } } as never, { $set: { briefStale: true } } as never);
        return result.modifiedCount;
    }

    /** Items still awaiting a sweep. The convergence signal `docs/gcp-deploy-plan.md` tells operators to watch. */
    countBriefStale(userId: string): Promise<number> {
        return this.countDocuments({ ...BRIEF_STALE_FILTER, user: userId });
    }

    /**
     * Every user id that owns at least one item. Served by a DISTINCT_SCAN over `{ user: 1 }`
     * (no collection scan); the reply is one BSON document, so it is bounded by the 16 MB reply
     * limit — ample for the foreseeable user count, revisit before it is not.
     */
    async distinctOwners(): Promise<string[]> {
        return this._collection.distinct('user');
    }

    /**
     * Builds the unique partial index that forbids two LIVE calendar items on the same standalone GCal
     * event. Kept OUT of `init` and called only after `dedupeCalendarItemsPerEvent` has run, because
     * `createIndexes` rejects (and would crash boot) if pre-existing data already violates it.
     *
     * The partial filter is `status: 'calendar'` AND `calendarEventId: { $type: 'string' }`:
     *  - `status: 'calendar'` (equality — the only `status` predicate a partial filter permits; `$ne`
     *    is not allowed) scopes the constraint to the live state. A `trash`/`done` row legitimately
     *    keeps its `calendarEventId` (so `findCalendarItemByEventId` can revive a trashed item) and
     *    must NOT collide with a freshly-recreated live row — e.g. cancel-then-recreate, move-to-past-
     *    then-revive. Scoping to `'calendar'` lets those coexist while still forbidding two live rows.
     *  - `calendarEventId: { $type: 'string' }` keeps everything but standalone calendar items out:
     *    routine-generated instance items carry `calendarInstanceEventId` (not `calendarEventId`) and
     *    in-app items omit the field. Mirrors the `calendarInstanceEventId` index above.
     */
    async ensureUniqueCalendarEventIndex() {
        await this._collection.createIndexes([
            {
                key: { user: 1, calendarEventId: 1 },
                unique: true,
                partialFilterExpression: { status: 'calendar', calendarEventId: { $type: 'string' } },
                name: 'uniq_calendar_item_per_event',
            },
        ]);
    }
}

export default new ItemsDAO();
