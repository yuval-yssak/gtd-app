import type { Filter, Sort } from 'mongodb';
import itemBriefsDAO from '../../dataAccess/itemBriefsDAO.js';
import itemsDAO from '../../dataAccess/itemsDAO.js';
import type { ItemBriefInterface, ItemInterface, ItemStatus } from '../../types/entities.js';
import { briefSourceHash, isPinnedOrigin } from '../briefSource.js';

/** Items that need a (re)generated brief, paired with the row they would replace. */
export interface BriefTarget {
    item: ItemInterface;
    brief?: ItemBriefInterface;
}

const LIVE_STATUSES: ItemStatus[] = ['inbox', 'nextAction', 'calendar', 'waitingFor', 'somedayMaybe'];
const ARCHIVE_STATUSES: ItemStatus[] = ['done', 'trash'];
/** Items per Mongo page and briefs per `$in` lookup — well under the 16 MB query ceiling. */
const PAGE_SIZE = 500;

/**
 * Selection rule shared by the sweep, the inline hook and the on-demand re-check: an item needs
 * generation when it has no brief row, or its row is stale (hash mismatch) AND replaceable
 * (`model` / `skipped`). Pinned rows are never targets, stale or not. Items whose notes are too
 * short ARE targets when no row exists — the caller records the skip so they drop out next time.
 */
export function isBriefTarget(item: Pick<ItemInterface, 'title' | 'notes'>, brief: ItemBriefInterface | undefined | null): boolean {
    if (!brief) {
        return true;
    }
    return brief.sourceHash !== briefSourceHash(item.title, item.notes) && !isPinnedOrigin(brief.origin);
}

/** The index that serves the page sort; hinted explicitly so the planner never prefers `{ user, status }`. */
const PAGE_INDEX = { user: 1, updatedTs: 1 } as const;

/**
 * The per-user page query. ALWAYS user-scoped: every index on `items` is `user`-prefixed, so a
 * cross-user `updatedTs` sort would be a collection scan plus a blocking in-memory sort that
 * aborts at Mongo's memory limit on real data. Sorted on `updatedTs` ONLY and hinted to
 * `{ user, updatedTs }` so the plan is a backward index walk with NO in-memory SORT stage: an
 * `_id` tiebreak would not be in that index and would bring the blocking sort back. Paging here
 * is one continuously-consumed cursor per (user, status group) — never skip/limit re-queries —
 * so no tiebreak is needed for stability. Exported so a test asserts the explain plan.
 */
export function briefTargetPageQuery(userId: string, statuses: ItemStatus[]): { filter: Filter<ItemInterface>; sort: Sort; hint: typeof PAGE_INDEX } {
    return { filter: { user: userId, status: { $in: statuses } }, sort: { updatedTs: -1 }, hint: PAGE_INDEX };
}

/** Loads one user's brief rows for a page of items in a single `$in` query, keyed by item id. */
async function loadBriefsForPage(userId: string, page: ItemInterface[]): Promise<Map<string, ItemBriefInterface>> {
    const ids = page.flatMap((item) => (item._id ? [item._id] : []));
    if (ids.length === 0) {
        return new Map();
    }
    const rows = await itemBriefsDAO.findArray({ user: userId, _id: { $in: ids } });
    return new Map(rows.map((row) => [row._id, row]));
}

/** Pages one user's status group newest-first over a single open cursor (see `briefTargetPageQuery`). */
async function* pageItems(userId: string, statuses: ItemStatus[]): AsyncGenerator<ItemInterface[]> {
    const { filter, sort, hint } = briefTargetPageQuery(userId, statuses);
    const cursor = itemsDAO.findSequence(filter, { sort, hint });
    // Accumulate into fixed-size pages so the brief lookup runs once per page, not per item.
    // The accumulator is intrinsic to chunking a stream; kept as a local mutable buffer on purpose.
    let page: ItemInterface[] = [];
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

async function targetsInPage(userId: string, page: ItemInterface[]): Promise<BriefTarget[]> {
    const briefs = await loadBriefsForPage(userId, page);
    return page.flatMap((item) => {
        const brief = item._id ? briefs.get(item._id) : undefined;
        if (!isBriefTarget(item, brief)) {
            return [];
        }
        return [brief ? { item, brief } : { item }];
    });
}

/** Collects a user's targets for one status group, stopping as soon as `remaining` is reached. */
async function collectTargets(userId: string, statuses: ItemStatus[], remaining: number): Promise<BriefTarget[]> {
    const collected: BriefTarget[] = [];
    for await (const page of pageItems(userId, statuses)) {
        collected.push(...(await targetsInPage(userId, page)));
        if (collected.length >= remaining) {
            break;
        }
    }
    return collected.slice(0, remaining);
}

/**
 * Selects up to `limit` generation targets across ALL users, live statuses (every user) before
 * the done/trash archive so the hot set is never starved by the backlog; within a user,
 * newest-first. Pure selection — the caller (Phase 3 sweep) decides what to do with each
 * target. The hash cannot be a database predicate, so items are paged and hashed in Node.
 */
export async function findBriefTargets(limit: number): Promise<BriefTarget[]> {
    // TODO(phase 3): users are walked in `distinctOwners()` order and the run stops at `limit`, so
    // with many users the tail never gets a live-pass slot in one run — add a rotating start
    // offset or a per-user quota when the sweep goes live.
    if (limit <= 0) {
        return [];
    }
    const owners = await itemsDAO.distinctOwners();
    const targets: BriefTarget[] = [];
    for (const statuses of [LIVE_STATUSES, ARCHIVE_STATUSES]) {
        for (const userId of owners) {
            targets.push(...(await collectTargets(userId, statuses, limit - targets.length)));
            if (targets.length >= limit) {
                return targets;
            }
        }
    }
    return targets;
}
