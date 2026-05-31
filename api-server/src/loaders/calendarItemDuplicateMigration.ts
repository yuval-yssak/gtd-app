import dayjs from 'dayjs';
import type { Db } from 'mongodb';

/**
 * Minimal shape for the dedup grouping — only the fields needed to choose a keeper.
 * Declared locally so dot-notation access satisfies `noPropertyAccessFromIndexSignature`.
 */
interface ItemDedupDoc {
    _id: string;
    user: string;
    calendarEventId?: string;
    status: string;
    updatedTs?: string;
}

/** A single grouped item projected by the aggregation — only the fields used to choose a keeper. */
interface GroupedItem {
    _id: string;
    updatedTs?: string;
}

interface DuplicateGroup {
    _id: { user: string; calendarEventId: string };
    docs: GroupedItem[];
}

/**
 * Collapses groups of ≥2 live `calendar` items bound to the same standalone GCal event
 * `(user, calendarEventId)` down to a single item, trashing the rest. Such duplicates arise when two
 * concurrent inbound syncs (a manual `POST /integrations/:id/sync` racing a webhook delivery) both see
 * `findCalendarItemByEventId` miss and both `createNewCalendarItem` with a fresh UUID — last-write-wins
 * cannot dedupe them because they carry distinct `_id`s.
 *
 * Why this runs at boot BEFORE `ensureUniqueCalendarEventIndex`: the unique partial index cannot be
 * built while violating data exists (`createIndexes` would reject and crash startup). This migration
 * guarantees the precondition. It is the automatic backstop; the scoped maintenance heal endpoint
 * covers on-demand recovery after which this is a no-op.
 *
 * The match is `status: 'calendar'` AND `calendarEventId: { $type: 'string' }` — exactly the predicate
 * of the unique index this migration unblocks (`ensureUniqueCalendarEventIndex`). Only live calendar
 * items participate: a `trash`/`done` row legitimately keeps its `calendarEventId` (so a trashed item
 * can be revived by `findCalendarItemByEventId`) and is outside the constraint. Routine-generated
 * instance items carry `calendarInstanceEventId` (not `calendarEventId`) and in-app items omit the
 * field — neither participates.
 *
 * Keeper rule: most-recently-updated wins, `_id` as a deterministic tie-break — the same ordering the
 * routine dedup uses (see `routineDuplicateMigration.ts`). Both outcomes converge, so a tie keeping a
 * different item is harmless.
 *
 * Items have no `active` flag, so losers are set to `status: 'trash'` (not demoted) — matching every
 * other GCal-driven removal in `calendar.ts` (`trashItem`, `updateItemsAndRecordOps`). Idempotent:
 * trashing a loser moves it out of the `status: 'calendar'` match, so a re-run finds no groups.
 * Direct DB write (no operation logged): connected devices reconcile the trash on their next item pull
 * via `updatedTs`, which we bump here.
 */
export async function dedupeCalendarItemsPerEvent(db: Db): Promise<void> {
    const coll = db.collection<ItemDedupDoc>('items');
    const groups = await findDuplicateItemGroups(db);
    if (!groups.length) {
        return;
    }

    const trashedIds = groups.flatMap((group) => idsToTrash(group.docs));
    console.log(`[migrate] items: ${groups.length} GCal events have multiple live calendar items — trashing ${trashedIds.length} duplicate(s)`);
    await coll.updateMany({ _id: { $in: trashedIds } } as never, { $set: { status: 'trash', updatedTs: dayjs().toISOString() } });
}

/** Aggregates live, GCal-linked calendar items into duplicate groups (≥2 sharing the strong key). */
async function findDuplicateItemGroups(db: Db): Promise<DuplicateGroup[]> {
    return db
        .collection<ItemDedupDoc>('items')
        .aggregate<DuplicateGroup>([
            { $match: { status: 'calendar', calendarEventId: { $type: 'string' } } },
            {
                $group: {
                    _id: { user: '$user', calendarEventId: '$calendarEventId' },
                    docs: { $push: { _id: '$_id', updatedTs: '$updatedTs' } },
                },
            },
            { $match: { 'docs.1': { $exists: true } } },
        ])
        .toArray();
}

/** Returns every item id in the group except the keeper (most-recently-updated, _id as tie-break). */
function idsToTrash(docs: GroupedItem[]): string[] {
    // Groups always have ≥2 docs (the aggregation filters on `docs.1` existing), so the keeper at index
    // 0 is dropped and at least one trash id remains.
    const [, ...rest] = [...docs].sort(byUpdatedThenIdDescending);
    return rest.map((doc) => doc._id);
}

/** Descending sort so the keeper is index 0: latest updatedTs first, then highest _id. */
function byUpdatedThenIdDescending(a: GroupedItem, b: GroupedItem): number {
    const tsDelta = (b.updatedTs ?? '').localeCompare(a.updatedTs ?? '');
    return tsDelta !== 0 ? tsDelta : b._id.localeCompare(a._id);
}
