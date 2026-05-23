/**
 * Backfills `calendarInstanceEventId` on routine-generated calendar items so the new exception
 * lookup path (preferred match by GCal instance id) can locate items that pre-date the rollout.
 *
 * Usage:
 *   cd api-server
 *   npx tsx --env-file=.env src/scripts/backfillCalendarInstanceEventIds.ts [options]
 *
 * Options:
 *   --user-email <email>  Scope to a single user. Default: all users.
 *   --dry-run             Print what would change without writing.
 *
 * For each candidate item, the original-occurrence date is derived from:
 *   (a) the item's `timeStart` directly, when it still matches the routine's schedule, OR
 *   (b) the matching `routineExceptions[].date` whose `newTimeStart` equals the item's `timeStart`
 *       (an instance that was moved by an earlier exception).
 * Items that cannot be resolved either way are logged + skipped — we don't guess.
 *
 * Records a sync `update` op for every modified item so connected devices learn about the new
 * field on their next /sync/pull. Deviceid: `backfill:calendar-instance-event-ids`.
 */

import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import { type AnyBulkWriteOperation, type Db, MongoBulkWriteError } from 'mongodb';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { buildCalendarInstanceEventId } from '../lib/routineItemRegeneration.js';
import { closeDataAccess, loadDataAccess } from '../loaders/mainLoader.js';
import type { CalendarSyncConfigInterface, ItemInterface, OperationInterface, RoutineInterface } from '../types/entities.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const BATCH_SIZE = 1000;
const DEVICE_ID = 'backfill:calendar-instance-event-ids';

interface CliOptions {
    userEmail?: string;
    dryRun: boolean;
}

interface Summary {
    scanned: number;
    updated: number;
    skippedNoDerivation: number;
    errors: number;
}

function parseArgs(argv: string[]): CliOptions {
    const get = (flag: string) => {
        const i = argv.indexOf(flag);
        if (i < 0) {
            return undefined;
        }
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
            throw new Error(`Flag ${flag} requires a value`);
        }
        return value;
    };
    const userEmail = get('--user-email');
    return { ...(userEmail !== undefined ? { userEmail } : {}), dryRun: argv.includes('--dry-run') };
}

async function findUserIdByEmail(database: Db, email: string): Promise<string> {
    const userDoc = await database.collection<{ _id: unknown; email: string }>('user').findOne({ email });
    if (!userDoc) {
        throw new Error(`No user found with email ${email}`);
    }
    return String(userDoc._id);
}

/**
 * Recovers the original rrule date for an item. If the item is still at its scheduled time, the
 * original date is the item's `timeStart` date. If a prior exception shifted the item, walk
 * `routineExceptions` for the entry whose `newTimeStart` matches and return its `date`.
 *
 * Exported so the unit tests can exercise the multi-match warning branch without spinning up the
 * whole script orchestrator.
 */
export function recoverOriginalOccurrenceDate(item: ItemInterface, routine: RoutineInterface): string | undefined {
    const itemStart = item.timeStart;
    if (!itemStart) {
        return undefined;
    }
    const template = routine.calendarItemTemplate;
    if (!template) {
        return undefined;
    }
    // Schedule-match: `timeStart` is the format `${date}T${timeOfDay}:00`. If the time-of-day suffix
    // matches the routine, the item is sitting on its original schedule and the date IS the original.
    const expectedSuffix = `T${template.timeOfDay}:00`;
    if (itemStart.includes(expectedSuffix)) {
        return itemStart.slice(0, 10);
    }
    // Otherwise look for the exception that moved it. Multiple matches (e.g. two routine instances
    // moved to the same wall-clock time) silently picks the first — log a warning so an operator
    // notices and can re-key the ambiguous rows manually. Don't escalate to skip: the first match
    // is still a reasonable guess and skipping would leave more rows un-backfilled.
    const matches = (routine.routineExceptions ?? []).filter((e) => e.type === 'modified' && e.newTimeStart === itemStart);
    if (matches.length > 1) {
        console.warn(
            `  ! recoverOriginalOccurrenceDate: ${matches.length} exceptions match itemId=${item._id} timeStart=${itemStart} routineId=${routine._id} — using first (${matches[0]?.date})`,
        );
    }
    return matches[0]?.date;
}

interface ResolvedRow {
    item: ItemInterface & { _id: string };
    routine: RoutineInterface;
    timeZone: string;
    originalDate: string;
}

function resolveRow(item: ItemInterface, routine: RoutineInterface, timeZone: string): ResolvedRow | undefined {
    const originalDate = recoverOriginalOccurrenceDate(item, routine);
    if (!originalDate || !item._id) {
        return undefined;
    }
    return { item: { ...item, _id: item._id }, routine, timeZone, originalDate };
}

function planUpdate(resolved: ResolvedRow): { update: AnyBulkWriteOperation<ItemInterface>; snapshot: ItemInterface & { _id: string }; nowIso: string } {
    const { item, routine, timeZone, originalDate } = resolved;
    const template = routine.calendarItemTemplate;
    if (!template || !routine.calendarEventId) {
        throw new Error(`planUpdate called with routine ${routine._id} missing template or calendarEventId`);
    }
    const { timeOfDay } = template;
    if (timeOfDay === undefined) {
        throw new Error(`planUpdate: routine ${routine._id} has all-day template; backfill not applicable (instance ids differ for all-day)`);
    }
    // dayjs.utc treats `YYYY-MM-DD` as midnight UTC; converting back to a JS Date is safe here.
    const occurrenceDate = dayjs.utc(originalDate).toDate();
    const instanceEventId = buildCalendarInstanceEventId(routine.calendarEventId, occurrenceDate, timeOfDay, timeZone);
    const nowIso = dayjs().toISOString();
    const snapshot: ItemInterface & { _id: string } = { ...item, calendarInstanceEventId: instanceEventId, updatedTs: nowIso };
    const update: AnyBulkWriteOperation<ItemInterface> = {
        updateOne: {
            filter: { _id: item._id, user: item.user } as never,
            update: { $set: { calendarInstanceEventId: instanceEventId, updatedTs: nowIso } } as never,
        },
    };
    return { update, snapshot, nowIso };
}

/** Looks up the calendar timezone for a routine's linked syncConfig. Falls back to UTC if missing. */
function resolveTimeZone(routine: RoutineInterface, configs: Map<string, CalendarSyncConfigInterface>): string {
    if (routine.calendarSyncConfigId) {
        const cfg = configs.get(routine.calendarSyncConfigId);
        if (cfg?.timeZone) {
            return cfg.timeZone;
        }
    }
    return 'UTC';
}

async function loadConfigsByUser(userId: string): Promise<Map<string, CalendarSyncConfigInterface>> {
    const list = await calendarSyncConfigsDAO.findByUser(userId);
    return new Map(list.map((c) => [c._id, c]));
}

/** Resolves rows for one user, returning the candidates that have all the info needed to backfill. */
async function resolveUserRows(userId: string, summary: Summary): Promise<ResolvedRow[]> {
    const configs = await loadConfigsByUser(userId);
    const linkedRoutines = await routinesDAO.findArray({ user: userId, calendarEventId: { $exists: true } });
    const routineById = new Map(linkedRoutines.map((r) => [r._id, r]));
    const items = await itemsDAO.findArray({
        user: userId,
        routineId: { $in: linkedRoutines.map((r) => r._id) },
        calendarInstanceEventId: { $exists: false },
    } as never);
    summary.scanned += items.length;
    return items.flatMap((item) => {
        if (!item.routineId) {
            return [];
        }
        const routine = routineById.get(item.routineId);
        if (!routine) {
            return [];
        }
        const tz = resolveTimeZone(routine, configs);
        const resolved = resolveRow(item, routine, tz);
        if (!resolved) {
            summary.skippedNoDerivation += 1;
            console.log(`  skip itemId=${item._id} routineId=${item.routineId} timeStart=${item.timeStart} — cannot derive original date`);
        }
        return resolved ? [resolved] : [];
    });
}

async function writeBatch(rows: ResolvedRow[], userId: string, summary: Summary): Promise<void> {
    if (rows.length === 0) {
        return;
    }
    const planned = rows.map((row) => planUpdate(row));
    let failedIndexes = new Set<number>();
    try {
        await itemsDAO.bulkWrite(
            planned.map((p) => p.update),
            { ordered: false },
        );
    } catch (err) {
        if (!(err instanceof MongoBulkWriteError)) {
            throw err;
        }
        const writeErrors = Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors];
        failedIndexes = new Set(writeErrors.map((we) => we.index));
        summary.errors += writeErrors.length;
        for (const we of writeErrors) {
            console.warn(`  ! bulk update failed at index ${we.index}: ${we.errmsg ?? 'unknown'}`);
        }
    }
    // Record ops only for the rows that actually persisted — otherwise we'd advertise a snapshot
    // the items collection never accepted.
    const successful = planned.filter((_, i) => !failedIndexes.has(i));
    summary.updated += successful.length;
    await recordOps(successful, userId, summary);
}

async function recordOps(planned: Array<{ snapshot: ItemInterface & { _id: string }; nowIso: string }>, userId: string, summary: Summary): Promise<void> {
    const ops: OperationInterface[] = planned.map(({ snapshot, nowIso }) => ({
        _id: randomUUID(),
        user: userId,
        deviceId: DEVICE_ID,
        ts: nowIso,
        entityType: 'item',
        entityId: snapshot._id,
        opType: 'update',
        snapshot,
    }));
    try {
        await operationsDAO.insertMany(ops, { ordered: false });
    } catch (err) {
        if (!(err instanceof MongoBulkWriteError)) {
            throw err;
        }
        const lost = ops.length - err.result.insertedCount;
        summary.errors += lost;
        console.warn(`  ! operations insertMany lost ${lost}/${ops.length} rows: ${err.message}`);
    }
}

async function chunkAndWrite(rows: ResolvedRow[], userId: string, opts: CliOptions, summary: Summary): Promise<void> {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        if (opts.dryRun) {
            summary.updated += batch.length;
            for (const row of batch) {
                console.log(`  would update itemId=${row.item._id} routineId=${row.routine._id} originalDate=${row.originalDate} tz=${row.timeZone}`);
            }
            continue;
        }
        await writeBatch(batch, userId, summary);
    }
}

async function processUser(userId: string, opts: CliOptions, summary: Summary): Promise<void> {
    const rows = await resolveUserRows(userId, summary);
    console.log(`User ${userId}: ${rows.length} item(s) to backfill${opts.dryRun ? ' (dry run)' : ''}.`);
    await chunkAndWrite(rows, userId, opts, summary);
}

async function listUserIds(opts: CliOptions, database: Db): Promise<string[]> {
    if (opts.userEmail) {
        return [await findUserIdByEmail(database, opts.userEmail)];
    }
    const usersWithItems = await database.collection<{ user: string }>('items').distinct('user' as never);
    return usersWithItems.map(String);
}

async function run(): Promise<void> {
    const opts = parseArgs(process.argv.slice(2));
    await loadDataAccess();
    // Import `db` after loadDataAccess() has populated it. The previous top-level import worked
    // (live ESM binding) but read as if `db` were already available at module load — moving it
    // here makes the dependency order explicit.
    const { db } = await import('../loaders/mainLoader.js');
    try {
        const userIds = await listUserIds(opts, db);
        console.log(`Scanning ${userIds.length} user(s)${opts.dryRun ? ' (dry run)' : ''}.`);
        const summary: Summary = { scanned: 0, updated: 0, skippedNoDerivation: 0, errors: 0 };
        for (const userId of userIds) {
            await processUser(userId, opts, summary);
        }
        console.log(
            `Done. scanned=${summary.scanned} updated=${summary.updated} skippedNoDerivation=${summary.skippedNoDerivation} errors=${summary.errors}${opts.dryRun ? ' (dry run)' : ''}`,
        );
    } finally {
        await closeDataAccess();
    }
}

// Only execute when invoked as a script (npx tsx ...), not when imported from a test for the
// `recoverOriginalOccurrenceDate` helper. `import.meta.url` matching `process.argv[1]` identifies
// the entrypoint case under tsx/node ESM.
const isDirectInvocation = (() => {
    if (!process.argv[1]) {
        return false;
    }
    try {
        const entryUrl = new URL(`file://${process.argv[1]}`).href;
        return import.meta.url === entryUrl;
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
