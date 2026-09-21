import type { AnyBulkWriteOperation, Document, Filter, UpdateFilter } from 'mongodb';
import type { ItemInterface } from '../../types/entities.js';

/**
 * The `items.briefStale` marker that turns "does this item need a brief?" from a full walk plus a
 * Node-side hash into a bounded indexed query (`lib/brief/briefTargets.ts`).
 *
 * The rules live here, separate from `ItemsDAO`, because both the DAO (which stamps the marker on
 * every write) and the backfill/tests reason about them. Two deliberate asymmetries:
 *
 *  - The marker is **conservative**: a write that COULD have moved the title/notes marks the item
 *    stale even when it did not. A false `true` costs one extra hash in the sweep's second pass;
 *    a false `false` would mean an item never gets a brief, so the two are not symmetric and the
 *    code always errs towards `true`.
 *  - The marker is **not an authority**. `briefWriter`'s compare-and-set re-reads the item and
 *    hashes title + notes for real; the marker only decides which items are looked at.
 *
 * **Tri-state, on purpose.** `true` = needs a sweep, `false` = swept and settled, ABSENT = never
 * seen by the marker at all. Settling writes `false` rather than removing the field, so "absent"
 * keeps meaning "pre-dates this feature" and the backfill's `$exists: false` filter stays dead
 * after its first run — see `ItemsDAO.markUnmarkedItemsStale`. Collapsing `false` into absent
 * would make the boot backfill re-mark the entire collection on every Cloud Run cold start.
 *
 * The index is partial on `briefStale: true`, so `false` costs one boolean per document on disk
 * and nothing in the index: the steady state still indexes zero keys.
 */

/**
 * The fields that can make an item (re)enter the sweep's candidate set.
 *
 * `title` / `notes` are the brief's source — moving either makes an existing brief stale.
 * `status` is here because targeting is scoped to open statuses: an item closed while stale simply
 * stops being a target, but one REVIVED from `trash` / reopened from `done` must become a target
 * again, and its title and notes did not change when that happened. Without `status` in this set a
 * status-only `$set` would leave a revived item permanently untargetable.
 */
const BRIEF_SOURCE_FIELDS = ['title', 'notes', 'status'] as const;

/** The update operators whose payload can carry one of `BRIEF_SOURCE_FIELDS`. */
const CONTENT_BEARING_OPERATORS = ['$set', '$setOnInsert', '$unset', '$rename'] as const;

/** Items the sweep must look at: the marker is the whole predicate, so it is indexed directly. */
export const BRIEF_STALE_FILTER: Filter<ItemInterface> = { briefStale: true };

/** Retires an item from the candidate set. `false`, never `$unset` — see the tri-state note above. */
export const SETTLE_BRIEF_STALE: UpdateFilter<ItemInterface> = { $set: { briefStale: false } };

/**
 * The item content a settle decision was made from. Settling compares these FIELDS rather than
 * `updatedTs`, because they are what the decision actually depended on: a write that changed the
 * content without bumping the timestamp would slip past a timestamp guard and settle an item whose
 * brief no longer describes it. `status` is included for the same reason it is watched on writes —
 * a revive must stay selectable.
 */
export type BriefSourceGuard = Pick<ItemInterface, 'title' | 'status'> & { notes: string | undefined };

/** What `clearBriefStaleBatch` settles: an id plus the content the sweep judged it on. */
export type SettledBriefItem = BriefSourceGuard & { _id: string };

/**
 * The equality clauses that pin a settle to the content it was decided from. `notes` is absent on
 * items that have none, and Mongo matches an absent field against `null` — so `notes: undefined`
 * must become `notes: null` rather than being dropped, or the guard would match any notes at all.
 */
export function briefSourceGuardFilter({ title, notes, status }: BriefSourceGuard): Filter<ItemInterface> {
    return { title, status, notes: notes ?? null } as Filter<ItemInterface>;
}

/**
 * Drops any caller-supplied `briefStale` from a full document. Every persisted item snapshot is
 * re-stamped from its own content by `markBriefStaleOnDocument`, so an inbound snapshot (a client
 * push replaying a server-written op, a reassign moving a document between owners) must not be
 * able to assert "settled" for content the server has not briefed.
 */
export function stripBriefStale<T extends Partial<ItemInterface>>(doc: T): Omit<T, 'briefStale'> {
    const { briefStale: _serverOwned, ...rest } = doc;
    return rest;
}

/**
 * Stamps a full item document as stale. Every insert/replace goes through this: the caller may be
 * writing new content, restoring an old snapshot or flipping an owner, and none of those can be
 * told apart cheaply from the document alone — so all of them re-enter the sweep's candidate set
 * and the (correct, hashing) second pass decides.
 */
export function markBriefStaleOnDocument<T extends Partial<ItemInterface>>(doc: T) {
    return { ...stripBriefStale(doc), briefStale: true as const };
}

/** True when one update-operator payload names any of `BRIEF_SOURCE_FIELDS`. */
function touchesBriefSource(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object') {
        return false;
    }
    return BRIEF_SOURCE_FIELDS.some((field) => field in payload);
}

/**
 * True when a partial update can move an item into (or within) the sweep's candidate set.
 *
 * An aggregation-PIPELINE update (an array of stages) always counts: its stages can compute a new
 * `title` or `notes` in ways no key test can see. Marking it unconditionally is the conservative
 * direction this module is built on — a spurious `true` costs one hash, a missed one strands the
 * item. No caller uses the pipeline form today; this keeps the guarantee true if one ever does.
 *
 * For the operator form, all three watched fields are scalars, so dotted paths and positional
 * operators cannot apply to them and a top-level key test is exact.
 */
export function updateTouchesBriefSource(update: UpdateFilter<ItemInterface> | Document[]): boolean {
    if (Array.isArray(update)) {
        return true;
    }
    return CONTENT_BEARING_OPERATORS.some((operator) => touchesBriefSource(update[operator]));
}

/**
 * Adds `briefStale: true` to an update that touches the brief source, leaving every other update
 * untouched. Returns the SAME object when nothing is needed so the overwhelmingly common case
 * (status flips, calendar-link bookkeeping) allocates nothing and reads identically in a log.
 *
 * A pipeline update gets a `$set` stage appended rather than a merged `$set` operator — the two
 * forms cannot be mixed in one statement.
 */
export function withBriefStaleMark<U extends UpdateFilter<ItemInterface> | Document[]>(update: U): U {
    if (!updateTouchesBriefSource(update)) {
        return update;
    }
    if (Array.isArray(update)) {
        return [...update, { $set: { briefStale: true } }] as U;
    }
    return { ...update, $set: { ...(update.$set ?? {}), briefStale: true } } as U;
}

/** The operations `ItemsDAO.bulkWrite` accepts, named once so the marker helper can narrow them. */
export type ItemBulkOperation = AnyBulkWriteOperation<ItemInterface>;

/**
 * The `bulkWrite` equivalent of `markBriefStaleOnDocument` / `withBriefStaleMark`: each operation
 * carries its own payload, so the DAO's `updateOne`/`replaceById` overrides never see them.
 * Operations that neither insert, replace nor touch the brief source pass through unchanged.
 */
export function markBriefStaleOnBulkOperation(operation: ItemBulkOperation): ItemBulkOperation {
    if ('insertOne' in operation) {
        return { insertOne: { document: markBriefStaleOnDocument(operation.insertOne.document) } };
    }
    if ('replaceOne' in operation) {
        return { replaceOne: { ...operation.replaceOne, replacement: markBriefStaleOnDocument(operation.replaceOne.replacement) } };
    }
    if ('updateOne' in operation) {
        return { updateOne: { ...operation.updateOne, update: withBriefStaleMark(operation.updateOne.update) } };
    }
    if ('updateMany' in operation) {
        return { updateMany: { ...operation.updateMany, update: withBriefStaleMark(operation.updateMany.update) } };
    }
    return operation;
}
