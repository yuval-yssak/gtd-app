/**
 * Paging rules for `GET /sync/pull`. Without a `limit` the route returns every op since the cursor in
 * one response (old clients); a device back from weeks offline then downloads an unbounded body.
 * With `limit` it returns pages, and the client follows `hasMore`.
 */

/** Largest page the server returns, whatever the client asks for. Each op carries a full snapshot. */
export const PULL_PAGE_MAX = 500;

interface Cursor {
    ts: string;
    id: string;
}

type ParsedLimit = { ok: true; limit: number | undefined } | { ok: false };

/** Digits only, no leading zero: `Number()` alone would also accept '1e2', '0x10' and ' 5 '. */
const POSITIVE_INTEGER = /^[1-9]\d*$/;

export function parsePullLimit(raw: string | undefined): ParsedLimit {
    if (raw === undefined) {
        return { ok: true, limit: undefined };
    }
    if (!POSITIVE_INTEGER.test(raw)) {
        return { ok: false };
    }
    return { ok: true, limit: Math.min(Number(raw), PULL_PAGE_MAX) };
}

export function isCursorAfter(a: Cursor, b: Cursor): boolean {
    return a.ts > b.ts || (a.ts === b.ts && a.id > b.id);
}

interface PageBoundary {
    /** The page's last op, if it returned any. */
    lastOp: Cursor | undefined;
    /** More ops exist after `lastOp` than this page returned. */
    hasMoreOps: boolean;
    holdback: Cursor;
    incoming: Cursor;
}

/**
 * Where the client pulls from next, and whether it should keep paging.
 *
 * Two clamps, unchanged from the unpaged route:
 *  - Never INTO the holdback window: an op committing late inside it must not land behind a cursor
 *    the client already holds. Fresh ops are still returned, then re-checked by the next pull.
 *  - Never BELOW the incoming cursor: a client already past the held-back boundary keeps its own.
 *
 * Paging continues only when the cursor really is the page's last op. A page reaching into the
 * window is held back, so continuing would fetch the same page again — it ends paging instead.
 */
export function nextPullCursor({ lastOp, hasMoreOps, holdback, incoming }: PageBoundary): { cursor: Cursor; hasMore: boolean } {
    const isHeldBack = lastOp === undefined || isCursorAfter(lastOp, holdback);
    const heldBackHighWater = isHeldBack ? holdback : lastOp;
    const isAheadOfIncoming = isCursorAfter(heldBackHighWater, incoming);
    return { cursor: isAheadOfIncoming ? heldBackHighWater : incoming, hasMore: hasMoreOps && !isHeldBack && isAheadOfIncoming };
}

interface PagedOp {
    ts: string;
    _id: string;
}

/** A page's ops, whether more remain after them, and the cursor of its last op. */
export interface PullPage<T extends PagedOp> {
    ops: T[];
    hasMoreOps: boolean;
    lastOp: Cursor | undefined;
}

function cursorOf(op: PagedOp | undefined): Cursor | undefined {
    return op === undefined ? undefined : { ts: op.ts, id: op._id };
}

/** `ops` was read with one row past `limit`: keep `limit` of them and report whether more remain. */
export function cutToLimit<T extends PagedOp>(ops: T[], limit: number | undefined): PullPage<T> {
    const pageOps = limit !== undefined && ops.length > limit ? ops.slice(0, limit) : ops;
    return { ops: pageOps, hasMoreOps: pageOps.length < ops.length, lastOp: cursorOf(pageOps.at(-1)) };
}

/**
 * A page cut off inside the holdback window must carry the rest of the window: its cursor will be
 * held back and paging ends there (see `nextPullCursor`), so ops cut off by `limit` would otherwise
 * wait for whatever pull happens to come next. The window holds a few seconds of writes at most, so
 * `limit` is a soft cap on that one page.
 */
export function shouldCarryRestOfWindow(page: Pick<PullPage<PagedOp>, 'hasMoreOps' | 'lastOp'>, holdback: Cursor): boolean {
    return page.hasMoreOps && page.lastOp !== undefined && isCursorAfter(page.lastOp, holdback);
}

/** The window-tail page: the cut-off page plus every op after it, ending paging. */
export function withRestOfWindow<T extends PagedOp>(page: PullPage<T>, rest: T[]): PullPage<T> {
    return { ops: [...page.ops, ...rest], hasMoreOps: false, lastOp: cursorOf(rest.at(-1)) ?? page.lastOp };
}
