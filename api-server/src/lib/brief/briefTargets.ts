import type { Filter } from 'mongodb';
import itemBriefsDAO from '../../dataAccess/itemBriefsDAO.js';
import itemsDAO from '../../dataAccess/itemsDAO.js';
import type { ItemBriefInterface, ItemInterface } from '../../types/entities.js';
import { briefSourceHash, isPinnedOrigin } from '../briefSource.js';
import { isBriefableStatus, LIVE_STATUSES } from './briefScope.js';
import type { PersistedItem } from './briefService.js';
import type { SettledBriefItem } from './briefStaleMarker.js';

/** Items that need a (re)generated brief, paired with the row they would replace. */
export interface BriefTarget {
    item: PersistedItem;
    brief?: ItemBriefInterface;
}

/** Items per Mongo page and briefs per `$in` lookup — well under the 16 MB query ceiling. */
const PAGE_SIZE = 500;

/**
 * Selection rule shared by the sweep, the inline hook and the on-demand re-check: an item needs
 * generation when its status is briefable AND it has no brief row, or its row is stale (hash
 * mismatch) AND replaceable (`model` / `skipped`). Pinned rows are never targets, stale or not.
 * Items whose notes are too short ARE targets when no row exists — the caller records the skip so
 * they drop out next time.
 *
 * The status test is repeated here even though the page query already bounds it: this function is
 * also the guard for the single-item paths (inline hook, on-demand), which never see that query.
 */
export function isBriefTarget(item: Pick<ItemInterface, 'title' | 'notes' | 'status'>, brief: ItemBriefInterface | undefined | null): boolean {
    if (!isBriefableStatus(item.status)) {
        return false;
    }
    if (!brief) {
        return true;
    }
    return brief.sourceHash !== briefSourceHash(item.title, item.notes) && !isPinnedOrigin(brief.origin);
}

/**
 * The index that serves the selection: `{ user, briefStale, status }`, partial on
 * `briefStale: true`. Hinted explicitly so the planner never prefers the far less selective
 * `{ user, status }` or `{ user, updatedTs }`.
 */
const PAGE_INDEX = { user: 1, briefStale: 1, status: 1 } as const;

/**
 * The per-user page query, and the whole reason this sweep is fast.
 *
 * Before the `briefStale` marker this walked EVERY item the user owns and hashed each one in Node,
 * because "is this brief stale?" compared a hash on `itemBriefs` against a hash computed from the
 * item's title + notes — not something Mongo can answer. On a 12 000-item corpus against a
 * throttled Atlas M0 that dragged the whole collection over the wire on every 15-minute tick and
 * cost 90–300 s, half of which 504'd at Cloud Run's request ceiling (docs/gcp-deploy-plan.md).
 *
 * The marker (`lib/brief/briefStaleMarker.ts`, maintained in `ItemsDAO`) turns the question into a
 * predicate: only items whose content may have moved since their brief row carry `briefStale: true`.
 * The filter is now fully covered by the partial index — in the steady state that index holds ZERO
 * keys, so the query examines zero documents and returns immediately. The expensive hash still
 * runs, but only over the handful of marked items, and only to decide the final verdict.
 *
 * ALWAYS user-scoped: every index on `items` is `user`-prefixed. Deliberately UNSORTED — the
 * previous design fought hard for a sort-free plan (`{ updatedTs: -1 }` hinted to
 * `{ user, updatedTs }`, no `_id` tiebreak) because any sort key outside the chosen index
 * reintroduces a blocking in-memory SORT, and `updatedTs` is not in this one. Index order is
 * accepted instead: ordering within a user no longer carries meaning, because the marked set IS
 * the whole backlog and it drains to empty rather than being a prioritised prefix of a much larger
 * walk. Exported so a test asserts the explain plan.
 */
export function briefTargetPageQuery(userId: string): { filter: Filter<ItemInterface>; hint: typeof PAGE_INDEX } {
    return { filter: { user: userId, briefStale: true, status: { $in: LIVE_STATUSES } }, hint: PAGE_INDEX };
}

/** Loads one user's brief rows for a page of items in a single `$in` query, keyed by item id. */
async function loadBriefsForPage(userId: string, page: PersistedItem[]): Promise<Map<string, ItemBriefInterface>> {
    const ids = page.map((item) => item._id);
    if (ids.length === 0) {
        return new Map();
    }
    const rows = await itemBriefsDAO.findArray({ user: userId, _id: { $in: ids } });
    return new Map(rows.map((row) => [row._id, row]));
}

/** Pages one user's marked live items in index order over a single open cursor (see `briefTargetPageQuery`). */
async function* pageItems(userId: string): AsyncGenerator<PersistedItem[]> {
    const { filter, hint } = briefTargetPageQuery(userId);
    const cursor = itemsDAO.findSequence<PersistedItem>(filter, { hint });
    // Accumulate into fixed-size pages so the brief lookup runs once per page, not per item.
    // The accumulator is intrinsic to chunking a stream; kept as a local mutable buffer on purpose.
    let page: PersistedItem[] = [];
    for await (const item of cursor) {
        page.push(item);
        if (page.length === PAGE_SIZE) {
            yield page;
            page = [];
        }
    }
    if (page.length > 0) {
        yield page;
    }
}

/**
 * Splits one page of marked items into the targets the caller must act on and the ids whose marker
 * is a false positive — marked by a write that turned out not to move the brief source (a status
 * flip between two live statuses, a title edit that round-tripped). Clearing those is what keeps
 * the marker set — and therefore the next sweep — from accumulating permanent residue.
 */
interface PageVerdict {
    targets: BriefTarget[];
    /** Full rows, not ids: settling is guarded on the CONTENT each was judged on (see the DAO). */
    settled: SettledBriefItem[];
}

async function classifyPage(userId: string, page: PersistedItem[]): Promise<PageVerdict> {
    const briefs = await loadBriefsForPage(userId, page);
    const targets = page.flatMap((item) => {
        const brief = briefs.get(item._id);
        if (!isBriefTarget(item, brief)) {
            return [];
        }
        return [brief ? { item, brief } : { item }];
    });
    const targeted = new Set(targets.map((target) => target.item._id));
    const settled = page.filter((item) => !targeted.has(item._id)).map(({ _id, title, notes, status }) => ({ _id, title, notes, status }));
    return { targets, settled };
}

/**
 * Collects ONE user's targets, clearing the marker on every item the hash comparison settles as
 * already-current. `remaining` caps how many targets are RETURNED, but the walk always finishes
 * the page it is on so its false positives are cleared — a marked item that is never cleared and
 * never targeted would be examined by every future sweep forever.
 */
export async function findUserBriefTargets(userId: string, remaining: number): Promise<BriefTarget[]> {
    const collected: BriefTarget[] = [];
    for await (const page of pageItems(userId)) {
        const { targets, settled } = await classifyPage(userId, page);
        await itemsDAO.clearBriefStaleBatch(userId, settled);
        collected.push(...targets);
        if (collected.length >= remaining) {
            break;
        }
    }
    return collected.slice(0, remaining);
}

/**
 * Selects up to `limit` generation targets across ALL users, live statuses only (see
 * `LIVE_STATUSES`). The caller (the Message Batches sweep) decides what to do with each target;
 * nothing here writes a brief. The hash still cannot be a database predicate, so the marked items
 * are paged and hashed in Node — the marker is what keeps that set small.
 *
 * NOT side-effect-free, unlike the pre-marker version: examining an item settles the question for
 * it, and `findUserBriefTargets` clears the marker on every non-target it sees. Leaving that to
 * the caller would mean a false positive stayed in the index until something happened to rewrite
 * the item, i.e. permanent residue in the one set this design keeps small.
 */
export async function findBriefTargets(limit: number): Promise<BriefTarget[]> {
    // TODO: users are walked in `distinctOwners()` order and the run stops at `limit`, so with many
    // users the tail never gets a slot in one run — add a rotating start offset or a per-user quota
    // when the user count makes that matter. Tolerable today because the marked set drains: a user
    // starved this tick keeps its markers and is reached once the earlier users settle.
    if (limit <= 0) {
        return [];
    }
    const owners = await itemsDAO.distinctOwners();
    const targets: BriefTarget[] = [];
    for (const userId of owners) {
        targets.push(...(await findUserBriefTargets(userId, limit - targets.length)));
        if (targets.length >= limit) {
            break;
        }
    }
    // One slice for both exits: a per-user call can overshoot `remaining` by finishing its page.
    return targets.slice(0, limit);
}
