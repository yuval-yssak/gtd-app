/**
 * Normalizes `routines.calendarEventId` by stripping the `_R<YYYYMMDDTHHMMSS>Z?` (timed) or
 * `_R<YYYYMMDD>` (all-day) recurrence-anchor suffix that GCal returns for rebased masters after
 * a "this and following" split done in GCal. See `normalizeMasterEventId` for the why.
 *
 * Usage:
 *   cd api-server
 *   npx tsx --env-file=.env src/scripts/normalizeRoutineCalendarEventIds.ts [options]
 *
 * Options:
 *   --user-email <email>  Scope to a single user. Default: all users with affected routines.
 *   --apply               Persist changes. Without this flag, runs as a dry run (default).
 *
 * Records a sync `update` op per modified routine so connected devices learn about the corrected
 * `calendarEventId` on their next /sync/pull. Device id: `backfill:normalize-routine-event-ids`.
 *
 * Idempotent: a bare master id passes through `normalizeMasterEventId` unchanged, so re-running
 * the script after a successful pass is a no-op.
 */

import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import type { Db } from 'mongodb';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { normalizeMasterEventId } from '../lib/routineItemRegeneration.js';
import { closeDataAccess, loadDataAccess } from '../loaders/mainLoader.js';
import type { OperationInterface, RoutineInterface } from '../types/entities.js';

const DEVICE_ID = 'backfill:normalize-routine-event-ids';

interface CliOptions {
    userEmail?: string;
    apply: boolean;
}

interface Summary {
    scanned: number;
    normalized: number;
    alreadyClean: number;
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
    return { ...(userEmail !== undefined ? { userEmail } : {}), apply: argv.includes('--apply') };
}

async function findUserIdByEmail(database: Db, email: string): Promise<string> {
    const userDoc = await database.collection<{ _id: unknown; email: string }>('user').findOne({ email });
    if (!userDoc) {
        throw new Error(`No user found with email ${email}`);
    }
    return String(userDoc._id);
}

async function listUserIds(opts: CliOptions, database: Db): Promise<string[]> {
    if (opts.userEmail) {
        return [await findUserIdByEmail(database, opts.userEmail)];
    }
    // Scope to users who have either a live or a renamed-on-disconnect link. Both can carry the
    // suffixed id; both need normalization for reconnect to find the right routine.
    const usersWithLinkedRoutines = await database
        .collection<{ user: string }>('routines')
        .distinct('user' as never, { $or: [{ calendarEventId: { $exists: true } }, { lastKnownCalendarEventId: { $exists: true } }] } as never);
    return usersWithLinkedRoutines.map(String);
}

/**
 * A single routine may need normalization on `calendarEventId` (live link), `lastKnownCalendarEventId`
 * (renamed on disconnect, awaiting reconnect), or both. The change record captures whichever fields
 * are dirty + their new values, so we write a single replaceById per routine instead of two.
 */
interface PlannedChange {
    routine: RoutineInterface;
    newCalendarEventId?: string;
    oldCalendarEventId?: string;
    newLastKnownCalendarEventId?: string;
    oldLastKnownCalendarEventId?: string;
}

function planChangesForRoutine(routine: RoutineInterface): PlannedChange | undefined {
    const change: PlannedChange = { routine };
    if (routine.calendarEventId) {
        const normalized = normalizeMasterEventId(routine.calendarEventId);
        if (normalized !== routine.calendarEventId) {
            change.oldCalendarEventId = routine.calendarEventId;
            change.newCalendarEventId = normalized;
        }
    }
    if (routine.lastKnownCalendarEventId) {
        const normalized = normalizeMasterEventId(routine.lastKnownCalendarEventId);
        if (normalized !== routine.lastKnownCalendarEventId) {
            change.oldLastKnownCalendarEventId = routine.lastKnownCalendarEventId;
            change.newLastKnownCalendarEventId = normalized;
        }
    }
    const dirty = change.newCalendarEventId !== undefined || change.newLastKnownCalendarEventId !== undefined;
    return dirty ? change : undefined;
}

function planChanges(routines: RoutineInterface[], summary: Summary): PlannedChange[] {
    return routines.flatMap((routine) => {
        summary.scanned += 1;
        const change = planChangesForRoutine(routine);
        if (!change) {
            summary.alreadyClean += 1;
            return [];
        }
        return [change];
    });
}

function describeChange(change: PlannedChange): string {
    const parts: string[] = [];
    if (change.newCalendarEventId !== undefined) {
        parts.push(`calendarEventId: ${change.oldCalendarEventId} → ${change.newCalendarEventId}`);
    }
    if (change.newLastKnownCalendarEventId !== undefined) {
        parts.push(`lastKnownCalendarEventId: ${change.oldLastKnownCalendarEventId} → ${change.newLastKnownCalendarEventId}`);
    }
    return parts.join('; ');
}

function buildNormalizedSnapshot(change: PlannedChange, nowIso: string): RoutineInterface {
    // Spread the routine first, then layer in only the fields that actually changed — keeps any
    // unrelated keys (lastSyncedNotes, routineExceptions, etc.) intact in the replacement.
    return {
        ...change.routine,
        ...(change.newCalendarEventId !== undefined ? { calendarEventId: change.newCalendarEventId } : {}),
        ...(change.newLastKnownCalendarEventId !== undefined ? { lastKnownCalendarEventId: change.newLastKnownCalendarEventId } : {}),
        updatedTs: nowIso,
    };
}

async function applyChange(change: PlannedChange, userId: string, summary: Summary): Promise<void> {
    const nowIso = dayjs().toISOString();
    const snapshot = buildNormalizedSnapshot(change, nowIso);
    try {
        await routinesDAO.replaceById(change.routine._id, snapshot);
    } catch (err) {
        summary.errors += 1;
        console.warn(`  ! replaceById failed for routineId=${change.routine._id}: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }
    const op: OperationInterface = {
        _id: randomUUID(),
        user: userId,
        deviceId: DEVICE_ID,
        ts: nowIso,
        entityType: 'routine',
        entityId: change.routine._id,
        opType: 'update',
        snapshot,
    };
    try {
        await operationsDAO.insertOne(op);
    } catch (err) {
        summary.errors += 1;
        console.warn(`  ! operations.insertOne failed for routineId=${change.routine._id}: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }
    summary.normalized += 1;
}

async function processUser(userId: string, opts: CliOptions, summary: Summary): Promise<void> {
    // Match the listUserIds scope so a routine renamed-on-disconnect is still found here.
    const routines = await routinesDAO.findArray({
        user: userId,
        $or: [{ calendarEventId: { $exists: true } }, { lastKnownCalendarEventId: { $exists: true } }],
    } as never);
    const changes = planChanges(routines, summary);
    const verb = opts.apply ? 'normalize' : 'would normalize';
    console.log(`User ${userId}: ${routines.length} routine(s) scanned, ${changes.length} to ${verb}.`);
    for (const change of changes) {
        console.log(`  ${verb} routineId=${change.routine._id} title="${change.routine.title}" ${describeChange(change)}`);
        if (opts.apply) {
            await applyChange(change, userId, summary);
        }
    }
}

async function run(): Promise<void> {
    const opts = parseArgs(process.argv.slice(2));
    await loadDataAccess();
    const { db } = await import('../loaders/mainLoader.js');
    try {
        const userIds = await listUserIds(opts, db);
        console.log(`Scanning ${userIds.length} user(s)${opts.apply ? '' : ' (dry run — pass --apply to persist)'}.`);
        const summary: Summary = { scanned: 0, normalized: 0, alreadyClean: 0, errors: 0 };
        for (const userId of userIds) {
            await processUser(userId, opts, summary);
        }
        const plannedOrApplied = opts.apply ? `normalized=${summary.normalized}` : `wouldNormalize=${summary.scanned - summary.alreadyClean}`;
        console.log(
            `Done. scanned=${summary.scanned} ${plannedOrApplied} alreadyClean=${summary.alreadyClean} errors=${summary.errors}${opts.apply ? '' : ' (dry run)'}`,
        );
    } finally {
        await closeDataAccess();
    }
}

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
