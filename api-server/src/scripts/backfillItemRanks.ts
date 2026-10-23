/**
 * One-off backfill for the Next Actions priority order (`ItemInterface.rank`), run per user after
 * the API + client that understand `rank` are deployed (docs/plans/next-actions-rank.md).
 *
 * Usage:
 *   cd api-server
 *   MONGO_DB_URL=… MONGO_DB_NAME=… npx tsx src/scripts/backfillItemRanks.ts [options]
 *
 * Options:
 *   --user-email <email>   Scope to one user. Default: every user that owns items.
 *   --dry-run              Print what would change without writing.
 *   --timezone <IANA>      The calendar day "today" is judged in (default Asia/Jerusalem).
 *   --force                Re-key users that already have ranked nextAction rows.
 *
 * Per user:
 *   1. D1 — a focused `nextAction` row with no `expectedBy` is stamped `expectedBy = today` (or its
 *      `ignoreBefore` when that is later, so a tickler-hidden row surfaces as "Today" on its wake
 *      day instead of already overdue). Its content changed, so its `updatedTs` is bumped.
 *   2. Only `status: 'nextAction'` rows are ranked — in the OLD comparator's order (focus first,
 *      dated before undated, `expectedBy` asc, then `createdTs` desc, `_id`) with `evenlySpacedRanks`,
 *      and `focus` is unset. Rank-only rows keep their existing `updatedTs`: ties go to the incoming
 *      snapshot on both server and client, so every device applies the rank, while a device's older
 *      unpushed edit still wins on push (the apply pipeline's rank carry-forward then preserves the
 *      rank).
 *   3. Done/trash/other rows, and routine templates, get `focus` unset with NO ops — ranking or
 *      re-publishing thousands of closed rows would bloat the op log and every bootstrap; the op
 *      schema still accepts `focus` and `stampSnapshot` strips any straggler.
 *   4. One `update` op per ranked row, built with `toServerOperation` immediately before its
 *      `insertMany` (op identity is stamped at insert time — a run-start clock can be skipped by the
 *      pull-side holdback), deviceId `backfill:item-ranks`, then `notifyChanges` so online tabs pull
 *      at once (and one webhook delivery per op for a subscribed user — accepted for a one-off).
 *   Idempotent: a user with ANY ranked nextAction row is skipped unless `--force`,
 *   in which case the existing rank order is preserved inside the old comparator's tiers. Note
 *   that `--force` does NOT bump `updatedTs` either: a device holding an unpushed edit of a
 *   re-keyed row pushes its old key back and that incoming rank wins — accepted for a one-off.
 */

import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import type { Db } from 'mongodb';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { toServerOperation } from '../lib/applyOperation.js';
import { compareRank, evenlySpacedRanks, rankAt } from '../lib/itemRank.js';
import { notifyChanges } from '../lib/notifyChange.js';
import { closeDataAccess, loadDataAccess } from '../loaders/mainLoader.js';
import type { ItemInterface, OperationInterface } from '../types/entities.js';

dayjs.extend(utc);
dayjs.extend(timezone);

export const BACKFILL_DEVICE_ID = 'backfill:item-ranks';
const OP_BATCH_SIZE = 500;

export interface BackfillOptions {
    userEmail?: string;
    dryRun: boolean;
    timezone: string;
    force: boolean;
}

export interface UserBackfillSummary {
    userId: string;
    nextActionRows: number;
    /** Focused undated rows stamped with a date (D1). */
    stampedToday: number;
    ranked: number;
    /** Closed/other rows + routine templates that lost a straggling `focus`. */
    focusUnsetElsewhere: number;
    skippedAlreadyRanked: boolean;
}

/** A legacy row as the backfill reads it: `focus` is gone from the interface but still on disk. */
type LegacyItem = ItemInterface & { focus?: boolean };

function parseArgs(argv: string[]): BackfillOptions {
    const argAfter = (flag: string) => {
        const idx = argv.indexOf(flag);
        return idx < 0 ? undefined : argv[idx + 1];
    };
    const userEmail = argAfter('--user-email');
    return {
        ...(userEmail !== undefined ? { userEmail } : {}),
        dryRun: argv.includes('--dry-run'),
        timezone: argAfter('--timezone') ?? 'Asia/Jerusalem',
        force: argv.includes('--force'),
    };
}

/** D1: the `expectedBy` a focused undated row receives — the run day, or its later tickler date. */
export function stampedExpectedBy(row: LegacyItem, runDay: string): string | null {
    if (row.focus !== true || row.expectedBy) {
        return null;
    }
    return row.ignoreBefore && row.ignoreBefore > runDay ? row.ignoreBefore : runDay;
}

/**
 * The pre-rank display order: focus first, dated before undated, `expectedBy` asc, then newest
 * `createdTs` first and `_id`. With `--force` a row's existing rank beats `createdTs` inside a tier
 * (unranked rows first, as the live comparator orders them) so a manual order survives the re-key.
 */
export function compareLegacyOrder(a: LegacyItem, b: LegacyItem): number {
    const focusDiff = Number(b.focus === true) - Number(a.focus === true);
    if (focusDiff !== 0) {
        return focusDiff;
    }
    const aDated = Boolean(a.expectedBy);
    const bDated = Boolean(b.expectedBy);
    if (aDated !== bDated) {
        return aDated ? -1 : 1;
    }
    // The OLD comparator compared the raw `expectedBy` strings (code-unit order) — reproduced as-is.
    const dateDiff = compareRank(a.expectedBy ?? '', b.expectedBy ?? '');
    if (dateDiff !== 0) {
        return dateDiff;
    }
    return compareWithinTier(a, b);
}

function compareWithinTier(a: LegacyItem, b: LegacyItem): number {
    if (a.rank !== undefined && b.rank !== undefined) {
        const rankDiff = compareRank(a.rank, b.rank);
        if (rankDiff !== 0) {
            return rankDiff;
        }
    } else if (a.rank !== undefined || b.rank !== undefined) {
        return a.rank === undefined ? -1 : 1;
    }
    const createdDiff = dayjs(b.createdTs).valueOf() - dayjs(a.createdTs).valueOf();
    return createdDiff !== 0 ? createdDiff : compareRank(a._id ?? '', b._id ?? '');
}

interface PlannedRow {
    before: LegacyItem;
    after: ItemInterface;
    stamped: boolean;
}

/** Pure planning step: the post-backfill shape of every nextAction row, in display order. */
export function planUserRanks(rows: LegacyItem[], runDay: string, nowIso: string): PlannedRow[] {
    const stamped = rows.map((row) => {
        const expectedBy = stampedExpectedBy(row, runDay);
        return expectedBy
            ? { before: row, stamped: true, withDate: { ...row, expectedBy, updatedTs: nowIso } }
            : { before: row, stamped: false, withDate: row };
    });
    const ordered = [...stamped].sort((a, b) => compareLegacyOrder(a.withDate, b.withDate));
    const ranks = evenlySpacedRanks(ordered.length);
    return ordered.map(({ before, stamped: wasStamped, withDate }, idx) => {
        const { focus: _focus, ...rest } = withDate;
        return { before, stamped: wasStamped, after: { ...rest, rank: rankAt(ranks, idx) } };
    });
}

/**
 * Writes the planned ranks. Every update is GUARDED on the row still being the one that was
 * planned (`status: 'nextAction'`, the `updatedTs` read at planning time): a row edited or
 * completed in between keeps its newer content — writing the planned `updatedTs` over it would
 * backdate the LWW anchor and let an older device snapshot erase the edit. `expectedBy` is set
 * only when the plan has one: the driver stores `undefined` as `null`, which the strict op schema
 * rejects (`expectedBy` is optional, not nullable) and would jam every later push of the row.
 */
async function writeRankedRows(planned: PlannedRow[]): Promise<void> {
    if (planned.length === 0) {
        return;
    }
    await itemsDAO.bulkWrite(
        planned.map(({ before, after }) => ({
            updateOne: {
                filter: { _id: after._id ?? '', user: after.user, status: 'nextAction', updatedTs: before.updatedTs },
                update: {
                    $set: {
                        rank: after.rank,
                        updatedTs: after.updatedTs,
                        ...(after.expectedBy !== undefined ? { expectedBy: after.expectedBy } : {}),
                    } as never,
                    $unset: { focus: '' } as never,
                },
            },
        })),
        { ordered: false },
    );
}

/**
 * The planned rows whose guarded write actually landed (re-read; a row that moved on keeps its own
 * state and gets no op). Under `--force` a row whose guarded write missed but which already held the
 * planned key would still be published — harmless, since the op's snapshot is the stored row.
 */
async function rowsThatLanded(userId: string, planned: PlannedRow[]): Promise<ItemInterface[]> {
    const ids = planned.map(({ after }) => after._id ?? '');
    const stored = await itemsDAO.findArray({ user: userId, _id: { $in: ids } });
    const plannedRank = new Map(planned.map(({ after }) => [after._id ?? '', after.rank]));
    return stored.filter((row) => row.rank !== undefined && row.rank === plannedRank.get(row._id ?? ''));
}

/** One update op per landed row (snapshot = the stored row), identities allocated right before the insert (see header). */
async function publishRankedRows(rows: ItemInterface[]): Promise<void> {
    for (let start = 0; start < rows.length; start += OP_BATCH_SIZE) {
        const batch = rows.slice(start, start + OP_BATCH_SIZE);
        const nowIso = dayjs().toISOString();
        const ops: OperationInterface[] = batch.map((row) =>
            toServerOperation(
                row.user,
                { entityType: 'item', opType: 'update', entityId: row._id ?? '', snapshot: row },
                { deviceId: BACKFILL_DEVICE_ID, now: nowIso },
            ),
        );
        await operationsDAO.insertMany(ops);
        // A nextAction row has no Google presence to push; SSE + web push are what we want here.
        await notifyChanges(ops, { suppressGCalPushback: true });
    }
}

/** Strips `focus` wherever it is NOT being ranked: closed/other items and routine templates. No ops. */
async function unsetFocusElsewhere(userId: string, dryRun: boolean): Promise<number> {
    const itemFilter = { user: userId, status: { $ne: 'nextAction' }, focus: { $exists: true } } as never;
    const routineFilter = { user: userId, 'template.focus': { $exists: true } } as never;
    if (dryRun) {
        return (await itemsDAO.countDocuments(itemFilter)) + (await routinesDAO.countDocuments(routineFilter));
    }
    const items = await itemsDAO.updateMany(itemFilter, { $unset: { focus: '' } } as never);
    const routines = await routinesDAO.updateMany(routineFilter, { $unset: { 'template.focus': '' } } as never);
    return items.modifiedCount + routines.modifiedCount;
}

function printDryRun(planned: PlannedRow[]): void {
    for (const { after, stamped } of planned) {
        console.log(`  would rank ${after._id} rank=${after.rank} expectedBy=${after.expectedBy ?? '-'}${stamped ? ' (stamped today)' : ''} "${after.title}"`);
    }
}

/** ANY ranked row means the rollout already reached this user — a single unranked straggler (a pre-rollout
 *  client's late push) must not turn a rerun into an N-op re-key; the app re-keys it on the first drag. */
function hasAnyRank(rows: LegacyItem[]): boolean {
    return rows.some((row) => row.rank !== undefined);
}

/**
 * Backfills one user. The closed-row / routine `focus` cleanup runs even for an already-ranked user
 * (it is idempotent and op-free); only the ranking is skipped without `--force`.
 */
export async function backfillUserItemRanks(userId: string, opts: BackfillOptions, now = dayjs()): Promise<UserBackfillSummary> {
    const rows = (await itemsDAO.findArray({ user: userId, status: 'nextAction' })) as LegacyItem[];
    const focusUnsetElsewhere = await unsetFocusElsewhere(userId, opts.dryRun);
    const base = { userId, nextActionRows: rows.length, focusUnsetElsewhere };
    if (hasAnyRank(rows) && !opts.force) {
        return { ...base, stampedToday: 0, ranked: 0, skippedAlreadyRanked: true };
    }
    const planned = planUserRanks(rows, now.tz(opts.timezone).format('YYYY-MM-DD'), now.toISOString());
    const summary = { ...base, stampedToday: planned.filter((row) => row.stamped).length, ranked: planned.length, skippedAlreadyRanked: false };
    if (opts.dryRun) {
        printDryRun(planned);
        return summary;
    }
    await writeRankedRows(planned);
    await publishRankedRows(await rowsThatLanded(userId, planned));
    return summary;
}

async function findUserIdByEmail(database: Db, email: string): Promise<string> {
    const userDoc = await database.collection<{ _id: unknown; email: string }>('user').findOne({ email });
    if (!userDoc) {
        throw new Error(`No user found with email ${email}`);
    }
    return String(userDoc._id);
}

async function listUserIds(opts: BackfillOptions, database: Db): Promise<string[]> {
    if (opts.userEmail) {
        return [await findUserIdByEmail(database, opts.userEmail)];
    }
    return itemsDAO.distinctOwners();
}

async function run(): Promise<void> {
    const opts = parseArgs(process.argv.slice(2));
    await loadDataAccess();
    const { db } = await import('../loaders/mainLoader.js');
    try {
        const userIds = await listUserIds(opts, db);
        console.log(
            `Backfilling item ranks for ${userIds.length} user(s)${opts.dryRun ? ' (dry run)' : ''}; today = ${dayjs().tz(opts.timezone).format('YYYY-MM-DD')} in ${opts.timezone}.`,
        );
        for (const userId of userIds) {
            const summary = await backfillUserItemRanks(userId, opts);
            console.log(
                summary.skippedAlreadyRanked
                    ? `User ${userId}: already has ranked rows, skipped (use --force to re-key).`
                    : `User ${userId}: ${JSON.stringify(summary)}`,
            );
        }
    } finally {
        await closeDataAccess();
    }
}

const isDirectInvocation = (() => {
    if (!process.argv[1]) {
        return false;
    }
    try {
        return import.meta.url === new URL(`file://${process.argv[1]}`).href;
    } catch {
        return false;
    }
})();

if (isDirectInvocation) {
    run().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
