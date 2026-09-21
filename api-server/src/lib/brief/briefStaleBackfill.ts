import itemsDAO from '../../dataAccess/itemsDAO.js';

/**
 * One-time repair for items that predate the `items.briefStale` marker (`briefStaleMarker.ts`).
 *
 * `ItemsDAO` stamps the marker on every write from the moment this ships, but a corpus written
 * before it has no marker at all — and "absent" MUST mean "not stale", or the sweep's bounded
 * indexed lookup degrades back into the full walk this change exists to remove. So every
 * pre-existing item is marked stale once and drains through the normal sweep, which writes the
 * brief row it was always owed and settles the marker. An item that already HAS a current brief
 * row is marked too: the sweep hashes it, finds nothing to do, settles it, and never looks at it
 * again — one wasted hash per item, exactly once.
 *
 * ENTIRELY server-side: the filter and the update are evaluated inside Mongo, so repairing a
 * 12 000-item corpus transfers one command and one reply, not 12 000 documents. That is what makes
 * it safe to run at boot on a throttled M0 cluster, next to the other `mainLoader` migrations.
 *
 * CONVERGENT, which is stronger than idempotent and is what makes it safe on the boot path.
 * `briefStale: { $exists: false }` claims only items the marker has never seen; a swept item is
 * settled with `briefStale: false`, NOT by removing the field, so it never matches again. Cloud
 * Run scales to zero and re-runs this on every cold start — several times a day — so a filter that
 * also matched the settled state would re-mark the whole collection each time and undo the very
 * fix this belongs to. `markUnmarkedItemsStale` carries the same warning next to the query.
 *
 * Restartable — a crash part-way leaves the remainder un-marked and the next boot finishes the
 * job; there is no intermediate state, because a marked item is simply a sweep candidate.
 *
 * Concurrent-deploy safe: a live instance writing an item through the DAO stamps `briefStale: true`
 * itself, which is the same value this migration would write, so the two cannot disagree.
 */

const LOG_PREFIX = '[brief-backfill]';

/** Returns how many items were newly marked — 0 once the corpus has converged. */
export async function backfillBriefStaleMarkers(): Promise<number> {
    const marked = await itemsDAO.markUnmarkedItemsStale();
    if (marked > 0) {
        console.log(`${LOG_PREFIX} marked ${marked} pre-existing item(s) stale; the brief sweep will drain them`);
    }
    return marked;
}
