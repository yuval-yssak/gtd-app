import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import { z } from 'zod';
import type { ItemInterface } from '../types/entities.js';
import { compareRank, evenlySpacedRanks, isRankTooLong, rankAt, rankBetween, ranksBetween } from './itemRank.js';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Pure core of `POST /v1/items/:id/move` — re-ordering one item inside its rank section, the
 * server-side twin of the app's drag / "Position" row. The section rules and the run re-key MIRROR
 * the client (`client/src/lib/rankSections.ts`, `client/src/lib/compareNextActions.ts`
 * `compareByRank`, `client/src/db/itemMutations.ts` `nonIncreasingRun` / `ensureRunRanked`), so an
 * order the API writes is the order the app shows (`tests/itemMoveParity.test.ts` + its client twin
 * pin the comparator and the run bounds). Two deliberate differences: the server sees one account
 * only (the app's merged multi-account list has no server equivalent), and it computes the expected
 * day in the user's reported timezone instead of the device's.
 */

/** The fields the order depends on. */
export type RankedRow = Pick<ItemInterface, 'rank' | 'createdTs'> & { _id: string };

export interface RankWrite {
    id: string;
    rank: string;
}

export interface MovePlan {
    /** Keys to write (re-keyed neighbours first and the moved row last, or the whole section on a rebalance). Empty = already in place. */
    writes: RankWrite[];
    /** 1-based position of the moved row in its section after the move. */
    position: number;
    total: number;
}

export type MoveTarget = z.infer<typeof MoveBodySchema>;

const DAY_KEYED_STATUSES: ReadonlySet<ItemInterface['status']> = new Set(['nextAction', 'waitingFor']);
const FLAT_STATUSES: ReadonlySet<ItemInterface['status']> = new Set(['inbox', 'somedayMaybe']);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_UTC_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * The calendar day `expectedBy` falls on for the user: a date-only value as-is, an instant (`Z` /
 * offset) converted into `timeZone`, and a floating datetime read AS wall time in `timeZone` — the
 * app parses it as device-local, so converting it from the server's zone would shift its day.
 */
export function expectedDayKey(expectedBy: string | undefined, timeZone: string): string | null {
    if (!expectedBy) {
        return null;
    }
    if (DATE_ONLY.test(expectedBy)) {
        return expectedBy;
    }
    const local = HAS_UTC_OFFSET.test(expectedBy) ? dayjs(expectedBy).tz(timeZone) : dayjs.tz(expectedBy, timeZone);
    return local.format('YYYY-MM-DD');
}

/** The section an item is ordered within, or null for a status with no manual order (calendar, done, trash). */
export function rankSectionKeyOf(item: Pick<ItemInterface, 'status' | 'expectedBy'>, timeZone: string): string | null {
    if (DAY_KEYED_STATUSES.has(item.status)) {
        return `${item.status}:${expectedDayKey(item.expectedBy, timeZone) ?? 'undated'}`;
    }
    return FLAT_STATUSES.has(item.status) ? item.status : null;
}

/** Unranked rows first (newest `createdTs` first), then `rank` by code unit, `_id` breaks every tie. */
export function compareByRank(a: RankedRow, b: RankedRow): number {
    const withinDay = compareWithinSection(a, b);
    return withinDay !== 0 ? withinDay : compareRank(a._id, b._id);
}

function compareWithinSection(a: RankedRow, b: RankedRow): number {
    if (a.rank !== undefined && b.rank !== undefined) {
        return compareRank(a.rank, b.rank);
    }
    if (a.rank !== undefined || b.rank !== undefined) {
        return a.rank === undefined ? -1 : 1;
    }
    return compareRank(b.createdTs, a.createdTs);
}

function isRankedBelow(a: RankedRow | undefined, b: RankedRow | undefined): boolean {
    return a?.rank !== undefined && b?.rank !== undefined && compareRank(a.rank, b.rank) < 0;
}

/** True when a key can be minted between the pair: an empty section, a ranked row at a section edge, or two strictly ordered rows. */
function isOrderedPair(a: RankedRow | undefined, b: RankedRow | undefined): boolean {
    if (!a && !b) {
        return true;
    }
    if (!a || !b) {
        return (a ?? b)?.rank !== undefined;
    }
    return isRankedBelow(a, b);
}

/**
 * The minimal contiguous window of `rows` around `[from, to]` whose keys must be re-minted —
 * grown outward while a boundary pair is unranked or not strictly increasing, then trimmed back
 * where an edge row's key already fits. Port of the client's `nonIncreasingRun`.
 */
export function nonIncreasingRun(rows: readonly RankedRow[], from: number, to: number): { lo: number; hi: number } {
    const ordered = (i: number) => isOrderedPair(rows[i], rows[i + 1]);
    const last = rows.length - 1;
    const bounds = { lo: Math.max(Math.min(from, to), 0), hi: Math.min(Math.max(from, to), last) };
    while (bounds.lo > 0 && !ordered(bounds.lo - 1)) {
        bounds.lo -= 1;
    }
    while (bounds.hi < last && !ordered(bounds.hi)) {
        bounds.hi += 1;
    }
    const hiEdgeFits = () =>
        rows[bounds.hi]?.rank !== undefined &&
        (bounds.hi === last || isRankedBelow(rows[bounds.hi], rows[bounds.hi + 1])) &&
        (bounds.lo === 0 || isRankedBelow(rows[bounds.lo - 1], rows[bounds.hi]));
    const loEdgeFits = () =>
        rows[bounds.lo]?.rank !== undefined &&
        (bounds.lo === 0 || isRankedBelow(rows[bounds.lo - 1], rows[bounds.lo])) &&
        (bounds.hi === last || isRankedBelow(rows[bounds.lo], rows[bounds.hi + 1]));
    while (bounds.hi > bounds.lo && hiEdgeFits()) {
        bounds.hi -= 1;
    }
    while (bounds.lo < bounds.hi && loEdgeFits()) {
        bounds.lo += 1;
    }
    return bounds;
}

/** The slot among the OTHER rows (0 … others.length) the target names. */
function targetSlot(others: readonly RankedRow[], target: MoveTarget): number {
    if ('position' in target) {
        return target.position === 'top' ? 0 : others.length;
    }
    const anchorId = 'before' in target ? target.before : target.after;
    const anchorIdx = others.findIndex((row) => row._id === anchorId);
    if (anchorIdx < 0) {
        throw new Error(`move anchor ${anchorId} is not in the section`);
    }
    return 'before' in target ? anchorIdx : anchorIdx + 1;
}

/**
 * Fresh keys for the run of `others` that must be re-keyed so a key fits at `slot`. Unlike the
 * client there is no whole-section fallback for inverted run bounds: `others` is ONE owner's rows
 * sorted by `compareByRank` (unranked prefix, then non-decreasing keys), and the run absorbs every
 * unranked or equal pair, so the keys just outside it are always strictly ordered.
 */
function rekeyAround(others: readonly RankedRow[], slot: number): RankWrite[] {
    const from = others[slot - 1] ? slot - 1 : slot;
    const { lo, hi } = nonIncreasingRun(others, from, others[slot] ? slot : from);
    const run = others.slice(lo, hi + 1);
    const keys = ranksBetween(others[lo - 1]?.rank ?? null, others[hi + 1]?.rank ?? null, run.length);
    return run.map((row, idx) => ({ id: row._id, rank: rankAt(keys, idx) }));
}

/** Re-keys the whole section in its new order from the origin — when a mint grew past `RANK_TOO_LONG_THRESHOLD` (mirrors the client's `rebalanceAround`). */
function rebalanced(others: readonly RankedRow[], movedId: string, slot: number): RankWrite[] {
    const ids = [...others.slice(0, slot).map((row) => row._id), movedId, ...others.slice(slot).map((row) => row._id)];
    const keys = evenlySpacedRanks(ids.length);
    return ids.map((id, idx) => ({ id, rank: rankAt(keys, idx) }));
}

function withWrites(rows: readonly RankedRow[], writes: readonly RankWrite[]): RankedRow[] {
    const byId = new Map(writes.map((write) => [write.id, write.rank]));
    return rows.map((row) => {
        const rank = byId.get(row._id);
        return rank === undefined ? row : { ...row, rank };
    });
}

/**
 * Plans moving `movedId` to `target` inside `section` (every row of its rank section, the moved
 * one included, any order). The anchor of a before/after target must be in the section — the
 * caller checks that first, so a miss throws. On the happy path it writes ONE key; it re-keys
 * neighbours only when they are unranked or not strictly increasing around the slot.
 */
export function planItemMove(section: readonly RankedRow[], movedId: string, target: MoveTarget): MovePlan {
    const ordered = [...section].sort(compareByRank);
    const others = ordered.filter((row) => row._id !== movedId);
    const slot = targetSlot(others, target);
    const placement = { position: slot + 1, total: ordered.length };
    if (ordered[slot]?._id === movedId) {
        return { writes: [], ...placement };
    }
    const neighbourWrites = isOrderedPair(others[slot - 1], others[slot]) ? [] : rekeyAround(others, slot);
    const rekeyed = withWrites(others, neighbourWrites);
    const movedRank = rankBetween(rekeyed[slot - 1]?.rank, rekeyed[slot]?.rank);
    if (isRankTooLong(movedRank)) {
        return { writes: rebalanced(others, movedId, slot), ...placement };
    }
    return { writes: [...neighbourWrites, { id: movedId, rank: movedRank }], ...placement };
}

/** The item id a before/after target names, or null for top/bottom. */
export function anchorIdOf(target: MoveTarget): string | null {
    if ('position' in target) {
        return null;
    }
    return 'before' in target ? target.before : target.after;
}

/**
 * Which row, if any, left the section between the caller's checks and its read of the section rows
 * (completed, re-dated or deleted meanwhile) — the plan is only valid when both are still in it.
 */
export function rowMissingFromSection(section: readonly RankedRow[], movedId: string, target: MoveTarget): 'item' | 'anchor' | null {
    const has = (id: string) => section.some((row) => row._id === id);
    if (!has(movedId)) {
        return 'item';
    }
    const anchorId = anchorIdOf(target);
    return anchorId === null || has(anchorId) ? null : 'anchor';
}

type ParsedMoveBody = { ok: true; value: MoveTarget } | { ok: false; message: string };

const anchorIdSchema = z.string().refine((id) => id.trim() !== '');

// Strict objects: a body naming two targets (or anything extra) matches no branch.
const MoveBodySchema = z.union([
    z.strictObject({ position: z.enum(['top', 'bottom']) }),
    z.strictObject({ before: anchorIdSchema }),
    z.strictObject({ after: anchorIdSchema }),
]);

/** Parses the move body: exactly one of `position` ('top' | 'bottom'), `before` or `after` (an item id), nothing else. */
export function parseMoveBody(raw: unknown): ParsedMoveBody {
    const parsed = MoveBodySchema.safeParse(raw);
    return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, message: 'body must be exactly one of { position: "top" | "bottom" }, { before: <itemId> }, { after: <itemId> }' };
}
