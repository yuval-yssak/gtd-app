/**
 * Retires ONE routine left stranded active on a GCal series whose master was cancelled, and trashes the
 * phantom future items it generated. This is the manual counterpart to `reapOrphanedSeriesSuccessors`
 * (`routes/calendar.ts`) for rows the automatic reap can never reach.
 *
 * WHY A SCRIPT AND NOT THE API: the reap is driven by an inbound cancelled master. When the series' last
 * occurrence is far in the past, a full sync's future `timeMin` means Google never re-reports that master,
 * so the stranded row cannot self-heal. Retiring it through the normal API (`gtd_update_routine` /
 * `POST /v1/routines/:id/pause`) fires `handleRoutinePush` -> `pushRoutinePause`, which WRITES TO GOOGLE
 * CALENDAR — unacceptable against a shared work calendar with real attendees. This script writes through
 * the DAOs and records sync operations (so other devices converge) WITHOUT `notifyChange`, which is where
 * the GCal pushback fan-out lives. Devices that pull these ops cannot bounce them back either:
 * `applyEntityOp` (client `db/syncHelpers.ts`) writes pulled ops straight to IndexedDB without re-queueing
 * them into `syncOperations`, so nothing re-enters `/sync/push`.
 *
 * It connects DIRECTLY rather than via `loadDataAccess()`, which would run boot migrations — including
 * `dedupeActiveRoutinesPerGCalSeries`, which can itself flip `active` on the very series being targeted.
 * That would both violate the dry-run contract and make the preview an unreliable predictor of the apply.
 *
 * Usage:
 *   cd api-server
 *   npx tsx --env-file=.env src/scripts/retireOrphanedSeriesSuccessor.ts \
 *     --user <userId> --routine <routineId> [--apply]
 *
 * Options:
 *   --user <id>      Required. Owner of the routine — scopes every read and write.
 *   --routine <id>   Required. The stranded routine to retire.
 *   --apply          Perform the writes. WITHOUT THIS THE SCRIPT ONLY PREVIEWS (default is dry run).
 *
 * Safety: idempotent — an already-inactive routine is left alone and only its lingering future items are
 * swept, and the rrule is never double-capped. Mirrors `deactivateRoutineFromGCal`'s writes exactly: the
 * rrule is CAPPED rather than merely paused (so the retirement stays reversible via the `newlyLosesUntil`
 * revival gate, and `healSplitSuccessorRoutines` — whose `isStrandedSuccessor` requires an OPEN rrule —
 * won't ping-pong with it), and trashed items release `calendarInstanceEventId` so the freed id no longer
 * occupies the presence-partial unique index.
 *
 * The retired routine is stamped `retiredByGCal: true` so the `/maintenance` heal endpoints (the
 * "Repair sync" button) skip it instead of stripping the cap and regenerating exactly the items this
 * script trashed. Re-running against a row retired BEFORE the marker existed backfills the stamp.
 *
 * Not wrapped in `withSyncLock`, so it can interleave with an in-flight webhook sync. Prefer a quiet
 * moment; re-running afterwards reconciles anything a concurrent sync re-created.
 */

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { MongoClient } from 'mongodb';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { recordOperation } from '../lib/operationHelpers.js';
import { addUntilToRrule } from '../lib/routineSplitUtils.js';
import type { ItemInterface, RoutineInterface } from '../types/entities.js';

dayjs.extend(utc);

export interface CliOptions {
    userId: string;
    routineId: string;
    apply: boolean;
}

function parseArgs(argv: string[]): CliOptions {
    const flagValue = (flag: string) => {
        const index = argv.indexOf(flag);
        if (index < 0) {
            return undefined;
        }
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
            throw new Error(`Flag ${flag} requires a value`);
        }
        return value;
    };
    const userId = flagValue('--user');
    const routineId = flagValue('--routine');
    if (!userId || !routineId) {
        throw new Error('Usage: --user <userId> --routine <routineId> [--apply]');
    }
    return { userId, routineId, apply: argv.includes('--apply') };
}

/**
 * `mongoDBConfig` defaults both fields to `''`, and `client.db('')` does NOT throw — it silently resolves
 * to the connection string's default database. For a script that mutates real calendar data, an unset
 * `MONGO_DB_NAME` must abort, not write somewhere the operator never named.
 */
function requireDbTarget(): { url: string; dbName: string } {
    const url = process.env.MONGO_DB_URL;
    const dbName = process.env.MONGO_DB_NAME;
    if (!url || !dbName) {
        throw new Error('ABORT: set MONGO_DB_URL and MONGO_DB_NAME (this script must never guess a database)');
    }
    return { url, dbName };
}

/**
 * The one-active-routine-per-series invariant this script reasons about is enforced by
 * `uniq_active_routine_per_gcal_series`. We deliberately do not BUILD it (a build can crash on
 * pre-existing violating data — the reason we skip the boot migrations at all), but its absence means
 * either an unmigrated database or the wrong one entirely, so assert it as a target canary.
 */
async function assertSeriesIndexPresent(client: MongoClient, dbName: string): Promise<void> {
    const indexes = await client.db(dbName).collection('routines').indexes();
    if (!indexes.some((index) => index.name === 'uniq_active_routine_per_gcal_series')) {
        throw new Error(`ABORT: ${dbName}.routines is missing uniq_active_routine_per_gcal_series — wrong or unmigrated database?`);
    }
}

/** Connect and init ONLY the collections this script touches — no migrations, no index builds. */
async function connectWithoutMigrations(): Promise<MongoClient> {
    const { url, dbName } = requireDbTarget();
    const client = new MongoClient(url);
    await client.connect();
    // `[^@]+` rather than `\w+` so a password containing URL-encoded or punctuation characters is still masked.
    console.log('MongoDB: connected to', url.replace(/:[^@]+@/, ':***@'), `db=${dbName}`);
    await assertSeriesIndexPresent(client, dbName);
    await Promise.all([routinesDAO.init(client, dbName), itemsDAO.init(client, dbName), operationsDAO.init(client, dbName)]);
    return client;
}

/**
 * Owner-scoped load plus a shape assertion. The script takes a bare id and mutates immediately, so a
 * mistyped character must fail loudly rather than retire an unrelated — possibly another user's — routine.
 */
async function loadRetirableRoutine(opts: CliOptions): Promise<RoutineInterface> {
    const routine = await routinesDAO.findByOwnerAndId(opts.routineId, opts.userId);
    if (!routine) {
        throw new Error(`ABORT: routine ${opts.routineId} not found for user ${opts.userId}`);
    }
    if (typeof routine.calendarEventId !== 'string' || routine.calendarEventId.length === 0) {
        throw new Error(`ABORT: routine ${opts.routineId} has no calendarEventId — not a GCal-linked series routine`);
    }
    return routine;
}

/** Future calendar items are the phantoms; past ones are real history and must be left untouched. Exported for unit testing. */
export function phantomItemsFilter(routine: RoutineInterface, now: string) {
    return { user: routine.user, routineId: routine._id, status: 'calendar' as const, timeStart: { $gte: now } };
}

/** Single source of truth for the cap — the preview and the write must never diverge. Exported for unit testing. */
export function cappedRrule(routine: RoutineInterface, now: string): string {
    return addUntilToRrule(routine.rrule, dayjs.utc(now).format('YYYY-MM-DD'));
}

async function printRetirementPlan(routine: RoutineInterface, phantoms: ItemInterface[], now: string): Promise<void> {
    const pastCount = await itemsDAO.countDocuments({ user: routine.user, routineId: routine._id, status: 'calendar', timeStart: { $lt: now } });
    console.log(`Routine ${routine._id} "${routine.title}"`);
    console.log(`  user=${routine.user} active=${routine.active}`);
    console.log(`  calendarEventId=${routine.calendarEventId} rebasedEventId=${routine.calendarRebasedEventId ?? 'none'}`);
    console.log(`  calendarIntegrationId=${routine.calendarIntegrationId ?? 'none'}`);
    console.log(`  rrule now:   ${routine.rrule}`);
    console.log(`  rrule after: ${cappedRrule(routine, now)}`);
    console.log(`  retiredByGCal: ${routine.retiredByGCal ? 'already set' : 'will be stamped'}`);
    console.log(`  past calendar items PRESERVED: ${pastCount}`);
    console.log(`  future calendar items to trash: ${phantoms.length}`);
    for (const item of phantoms) {
        console.log(`    ${item._id} ${item.timeStart}`);
    }
}

/**
 * Mirrors `deactivateRoutineFromGCal`'s heuristic-reap path: cap the rrule AND pause, in one snapshot.
 * Re-fetches first so a concurrent write isn't clobbered — same reason the original re-fetches.
 * Relies on the caller having loaded the routine (`replaceById` upserts, so it would otherwise CREATE one).
 */
async function retireRoutine(routine: RoutineInterface, now: string): Promise<void> {
    const fresh = (await routinesDAO.findByOwnerAndId(routine._id, routine.user)) ?? routine;
    const updated: RoutineInterface = { ...fresh, rrule: cappedRrule(fresh, now), active: false, retiredByGCal: true, updatedTs: now };
    await routinesDAO.replaceById(routine._id, updated);
    await recordOperation(routine.user, { entityType: 'routine', entityId: routine._id, snapshot: updated, opType: 'update', now });
}

/**
 * Backfill for rows retired BEFORE `retiredByGCal` existed (including this script's own earlier runs):
 * an already-inactive routine is otherwise left alone, but without the marker the `/maintenance` heal
 * endpoints still match its shape and would resurrect it. Stamping is the only write; rrule/active stay.
 */
async function stampRetirementMarker(routine: RoutineInterface, now: string): Promise<void> {
    const fresh = (await routinesDAO.findByOwnerAndId(routine._id, routine.user)) ?? routine;
    if (fresh.retiredByGCal) {
        return;
    }
    const updated: RoutineInterface = { ...fresh, retiredByGCal: true, updatedTs: now };
    await routinesDAO.replaceById(routine._id, updated);
    await recordOperation(routine.user, { entityType: 'routine', entityId: routine._id, snapshot: updated, opType: 'update', now });
    console.log('Stamped retiredByGCal on already-inactive routine (heal-endpoint protection backfill).');
}

/**
 * Mirrors `updateItemsAndRecordOps`: write through the ORIGINAL filter (so an item trashed concurrently
 * isn't re-stamped), then snapshot the post-write state by stable id.
 */
async function trashPhantomItems(routine: RoutineInterface, phantoms: ItemInterface[], now: string): Promise<void> {
    const ids = phantoms.map((item) => item._id).filter((id): id is string => Boolean(id));
    if (ids.length === 0) {
        return;
    }
    await itemsDAO.updateMany(phantomItemsFilter(routine, now), { $set: { status: 'trash', updatedTs: now }, $unset: { calendarInstanceEventId: '' } });
    const updated = await itemsDAO.findArray({ _id: { $in: ids }, user: routine.user });
    await Promise.all(
        updated.flatMap((item) => {
            const itemId = item._id;
            if (!itemId) {
                return [];
            }
            return [recordOperation(routine.user, { entityType: 'item', entityId: itemId, snapshot: item, opType: 'update', now })];
        }),
    );
}

/** Exported for unit testing — the caller owns the DB connection. */
export async function retireStrandedSuccessor(opts: CliOptions, now: string): Promise<void> {
    const routine = await loadRetirableRoutine(opts);
    const phantoms = await itemsDAO.findArray(phantomItemsFilter(routine, now));
    await printRetirementPlan(routine, phantoms, now);

    if (!opts.apply) {
        console.log('DRY RUN — nothing written. Re-run with --apply to perform these changes.');
        return;
    }
    if (routine.active) {
        await retireRoutine(routine, now);
    } else {
        console.log('Routine already inactive — sweeping lingering future items and backfilling the retirement marker if absent.');
        await stampRetirementMarker(routine, now);
    }
    await trashPhantomItems(routine, phantoms, now);
    console.log(`Done. routineRetired=${routine.active} itemsTrashed=${phantoms.length}`);
}

async function run(): Promise<void> {
    const opts = parseArgs(process.argv.slice(2));
    const client = await connectWithoutMigrations();
    try {
        await retireStrandedSuccessor(opts, dayjs().toISOString());
    } finally {
        await client.close();
        console.log('MongoDB: connection closed');
    }
}

// Guarded so the test suite can import the exported helpers without the CLI connecting and running.
if (process.env.NODE_ENV !== 'test') {
    run().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
