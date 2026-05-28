import dayjs from 'dayjs';
import type { Db } from 'mongodb';

/**
 * Minimal shape for the dedup grouping — only the fields needed to choose a keeper.
 * Declared locally so dot-notation access satisfies `noPropertyAccessFromIndexSignature`.
 */
interface RoutineDedupDoc {
    _id: string;
    user: string;
    calendarEventId?: string;
    calendarIntegrationId?: string;
    active: boolean;
    updatedTs?: string;
}

/** A single grouped routine projected by the aggregation — only the fields used to choose a keeper. */
interface GroupedRoutine {
    _id: string;
    updatedTs?: string;
}

interface DuplicateGroup {
    _id: { user: string; calendarEventId: string; calendarIntegrationId: string | null };
    docs: GroupedRoutine[];
}

/**
 * Collapses groups of ≥2 ACTIVE routines bound to the same GCal recurring series
 * `(user, calendarEventId, calendarIntegrationId)` down to a single active routine, demoting the rest
 * to `active:false`. Such duplicates make two routines generate the same `calendarInstanceEventId` per
 * date, colliding on the items unique index and throwing the whole webhook sync.
 *
 * Why this runs at boot BEFORE `ensureUniqueActiveSeriesIndex`: the unique partial index cannot be
 * built while violating data exists (`createIndexes` would reject and crash startup). This migration
 * guarantees the precondition. It is the automatic backstop; a deliberate data heal may pick a smarter
 * keeper (e.g. the routine with the most real items) ahead of deploy — after which this is a no-op.
 *
 * Keeper rule: most-recently-updated wins — the same primary ordering `findExistingRoutineForEvent`
 * uses, so the routine the inbound-update path resolves to is normally the one we keep active. On an
 * exact `updatedTs` tie we add `_id` as a deterministic secondary sort (the read path has no such
 * tie-break); both outcomes are convergent, so a tie keeping a different routine is harmless.
 *
 * Idempotent — re-running finds no groups (each series has exactly one active routine) and is a no-op.
 * Direct DB write (no operation logged): connected devices reconcile the `active:false` flip on their
 * next full routine pull via `updatedTs`, which we bump here.
 */
export async function dedupeActiveRoutinesPerGCalSeries(db: Db): Promise<void> {
    const coll = db.collection<RoutineDedupDoc>('routines');
    const groups = await findActiveDuplicateGroups(db);
    if (!groups.length) {
        return;
    }

    const demotedIds = groups.flatMap((group) => idsToDemote(group.docs));
    console.log(`[migrate] routines: ${groups.length} GCal series have multiple active routines — demoting ${demotedIds.length} duplicate(s) to active:false`);
    await coll.updateMany({ _id: { $in: demotedIds } } as never, { $set: { active: false, updatedTs: dayjs().toISOString() } });
}

/** Aggregates active, GCal-linked routines into duplicate groups (≥2 sharing the strong key). */
async function findActiveDuplicateGroups(db: Db): Promise<DuplicateGroup[]> {
    return db
        .collection<RoutineDedupDoc>('routines')
        .aggregate<DuplicateGroup>([
            { $match: { active: true, calendarEventId: { $type: 'string' } } },
            {
                $group: {
                    _id: { user: '$user', calendarEventId: '$calendarEventId', calendarIntegrationId: '$calendarIntegrationId' },
                    docs: { $push: { _id: '$_id', updatedTs: '$updatedTs' } },
                },
            },
            { $match: { 'docs.1': { $exists: true } } },
        ])
        .toArray();
}

/** Returns every routine id in the group except the keeper (most-recently-updated, _id as tie-break). */
function idsToDemote(docs: GroupedRoutine[]): string[] {
    // Groups always have ≥2 docs (the aggregation filters on `docs.1` existing), so the keeper at index
    // 0 is dropped and at least one demotion id remains.
    const [, ...rest] = [...docs].sort(byUpdatedThenIdDescending);
    return rest.map((doc) => doc._id);
}

/** Descending sort so the keeper is index 0: latest updatedTs first, then highest _id. */
function byUpdatedThenIdDescending(a: GroupedRoutine, b: GroupedRoutine): number {
    const tsDelta = (b.updatedTs ?? '').localeCompare(a.updatedTs ?? '');
    return tsDelta !== 0 ? tsDelta : b._id.localeCompare(a._id);
}
