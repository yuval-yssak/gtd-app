/**
 * One-off cleanup: deletes a specific allow-list of `gtd*`-clone routines and ALL their items from
 * the app DB only (never touches Google Calendar). These clone routines are duplicates born from the
 * disconnect/reconnect pushback race — the app pushed a synthetic `gtd<hash>` clone event outbound,
 * which then re-entered as its own routine. The real routine (keyed on the genuine GCal master id)
 * already covers these instances, so the clone + its naked items are pure duplicates.
 *
 * DB-only by design: the `gtd*` "master" is a junk id that may or may not exist on GCal, and the clone
 * items are naked (no calendarInstanceEventId / integration link), so there is nothing to tear down on
 * Google's side. Every delete records a `delete` operation so the user's other devices converge on pull.
 *
 * Usage (staging):
 *   cd api-server
 *   MONGO_DB_URL='<staging-uri>' MONGO_DB_NAME=gtdStagingDB \
 *     npx tsx src/scripts/deleteCloneRoutines.ts --user <userId> --routine-ids <id1,id2,...> [--dry-run]
 *
 * Safety guards (abort the whole run if ANY target violates them — these are the invariants that make
 * the clone safe to delete):
 *   - the routine's calendarEventId must start with "gtd" (it must actually be a clone),
 *   - it must own ZERO GCal-linked items (no item with a calendarInstanceEventId) — a linked item means
 *     it is the real series for something and must not be blindly deleted.
 */

import dayjs from 'dayjs';
import itemsDAO from '../dataAccess/itemsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { recordOperation } from '../lib/operationHelpers.js';
import { closeDataAccess, loadDataAccess } from '../loaders/mainLoader.js';
import type { ItemInterface, RoutineInterface } from '../types/entities.js';

interface CliOptions {
    userId: string;
    routineIds: string[];
    dryRun: boolean;
}

function parseArgs(argv: string[]): CliOptions {
    const get = (flag: string): string | undefined => {
        const i = argv.indexOf(flag);
        return i < 0 ? undefined : argv[i + 1];
    };
    const userId = get('--user');
    const routineIdsRaw = get('--routine-ids');
    if (!userId || !routineIdsRaw) {
        throw new Error('Usage: --user <userId> --routine-ids <id1,id2,...> [--dry-run]');
    }
    const routineIds = routineIdsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (!routineIds.length) {
        throw new Error('--routine-ids must list at least one routine id');
    }
    return { userId, routineIds, dryRun: argv.includes('--dry-run') };
}

/** Throws if a target routine isn't a clone or owns a GCal-linked item — the safety invariants. */
function assertSafeToDelete(routine: RoutineInterface, items: ItemInterface[]): void {
    if (!routine.calendarEventId?.startsWith('gtd')) {
        throw new Error(`ABORT: routine ${routine._id} ("${routine.title}") is not a gtd* clone (eId=${routine.calendarEventId}) — refusing to delete`);
    }
    const linked = items.filter((i) => i.calendarInstanceEventId);
    if (linked.length > 0) {
        throw new Error(`ABORT: routine ${routine._id} ("${routine.title}") owns ${linked.length} GCal-linked item(s) — refusing to delete`);
    }
}

async function loadTarget(userId: string, routineId: string): Promise<{ routine: RoutineInterface; items: ItemInterface[] }> {
    const routine = await routinesDAO.findByOwnerAndId(routineId, userId);
    if (!routine) {
        throw new Error(`ABORT: routine ${routineId} not found for user ${userId}`);
    }
    const items = await itemsDAO.findArray({ user: userId, routineId });
    return { routine, items };
}

async function deleteItemRecordingOp(item: ItemInterface, userId: string, now: string): Promise<void> {
    if (!item._id) {
        return;
    }
    // Record the op BEFORE the DB delete so a mid-run crash still propagates the delete on next pull.
    await recordOperation(userId, { entityType: 'item', entityId: item._id, snapshot: null, opType: 'delete', now });
    await itemsDAO.deleteByOwner(item._id, userId);
}

async function deleteRoutineRecordingOp(routine: RoutineInterface, userId: string, now: string): Promise<void> {
    await recordOperation(userId, { entityType: 'routine', entityId: routine._id, snapshot: null, opType: 'delete', now });
    await routinesDAO.deleteByOwner(routine._id, userId);
}

async function deleteOneCloneRoutine(target: { routine: RoutineInterface; items: ItemInterface[] }, userId: string): Promise<number> {
    const now = dayjs().toISOString();
    for (const item of target.items) {
        await deleteItemRecordingOp(item, userId, now);
    }
    await deleteRoutineRecordingOp(target.routine, userId, now);
    return target.items.length;
}

async function run(): Promise<void> {
    const opts = parseArgs(process.argv.slice(2));
    await loadDataAccess();
    try {
        const targets = await Promise.all(opts.routineIds.map((id) => loadTarget(opts.userId, id)));
        // Validate ALL targets before deleting ANY — a single violation aborts the whole run.
        for (const t of targets) {
            assertSafeToDelete(t.routine, t.items);
            console.log(`[target] ${t.routine._id} "${t.routine.title}" eId=${t.routine.calendarEventId} items=${t.items.length}`);
        }
        if (opts.dryRun) {
            console.log(
                `\nDRY RUN — would delete ${targets.length} routine(s) + ${targets.reduce((n, t) => n + t.items.length, 0)} item(s). No writes performed.`,
            );
            return;
        }
        let itemsDeleted = 0;
        for (const t of targets) {
            itemsDeleted += await deleteOneCloneRoutine(t, opts.userId);
        }
        console.log(`\nDone. Deleted ${targets.length} clone routine(s) + ${itemsDeleted} item(s); recorded delete ops for device convergence.`);
    } finally {
        await closeDataAccess();
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
