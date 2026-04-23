/**
 * Re-runs the tightened pickSplitParent matcher against all routines that currently carry a
 * splitFromRoutineId, and corrects (or clears) links that the old loose heuristic set
 * incorrectly. Records a routine-update operation for every change so connected devices pick
 * up the correction via sync pull.
 *
 * Usage:
 *   cd api-server
 *   npx tsx --env-file=.env src/scripts/backfillSplitFromRoutineId.ts [options]
 *
 * Options:
 *   --email <email>   Scope to a single user. Default: all users with linked routines.
 *   --dry-run         Print what would change without writing.
 *
 * Safety: idempotent. Re-running after fixes have been applied is a no-op. The script never
 * deletes a routine or a legitimate link — if the new matcher cannot find a better parent for
 * a routine whose existing link is invalid under the new rules, it clears splitFromRoutineId
 * (the routine becomes standalone, which is the correct state when no real parent exists).
 */

import dayjs from 'dayjs';
import type { Db } from 'mongodb';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { recordOperation } from '../lib/operationHelpers.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { pickSplitParent } from '../routes/calendar.js';
import type { RoutineInterface } from '../types/entities.js';

interface CliOptions {
    email?: string;
    dryRun: boolean;
}

interface Summary {
    scanned: number;
    relinked: number;
    cleared: number;
    unchanged: number;
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
    const email = get('--email');
    return {
        ...(email !== undefined ? { email } : {}),
        dryRun: argv.includes('--dry-run'),
    };
}

async function findUserIdByEmail(database: Db, email: string): Promise<string> {
    const userDoc = await database.collection<{ _id: unknown; email: string }>('user').findOne({ email });
    if (!userDoc) {
        throw new Error(`No user found with email ${email}`);
    }
    return String(userDoc._id);
}

async function resolveUserScope(opts: CliOptions): Promise<{ user?: string }> {
    if (!opts.email) {
        return {};
    }
    const userId = await findUserIdByEmail(db, opts.email);
    console.log(`Scoped to user ${opts.email} -> ${userId}`);
    return { user: userId };
}

/**
 * For the backfill we want to re-evaluate each linked tail against the same kind of candidate
 * set the live code sees at import time: the user's other routines that carry UNTIL in their
 * rrule. `calendarEventId` on the tail stands in for the import-time GCal event's start —
 * we use the routine's createdTs (which matches the split instance's start for tails) as the
 * tail-start anchor for pickSplitParent.
 */
async function candidateParentsFor(tail: RoutineInterface): Promise<RoutineInterface[]> {
    return routinesDAO.findArray({
        user: tail.user,
        _id: { $ne: tail._id },
        rrule: { $regex: 'UNTIL=' },
    });
}

async function correctOne(tail: RoutineInterface, opts: CliOptions, summary: Summary): Promise<Summary> {
    const candidates = await candidateParentsFor(tail);
    const picked = pickSplitParent({
        tail: {
            title: tail.title,
            rrule: tail.rrule,
            calendarSyncConfigId: tail.calendarSyncConfigId,
            tailStart: tail.createdTs,
        },
        candidates,
    });
    const newLink = picked?._id;

    if (newLink === tail.splitFromRoutineId) {
        return { ...summary, unchanged: summary.unchanged + 1 };
    }

    const label = newLink ? `relink ${tail.splitFromRoutineId} → ${newLink}` : `clear (was ${tail.splitFromRoutineId})`;
    console.log(`  routine ${tail._id} "${tail.title}" — ${label}`);

    if (opts.dryRun) {
        return newLink ? { ...summary, relinked: summary.relinked + 1 } : { ...summary, cleared: summary.cleared + 1 };
    }

    const now = dayjs().toISOString();
    const updated: RoutineInterface = newLink
        ? { ...tail, splitFromRoutineId: newLink, updatedTs: now }
        : (() => {
              const { splitFromRoutineId: _drop, ...rest } = tail;
              return { ...rest, updatedTs: now };
          })();

    await routinesDAO.replaceById(tail._id, updated);
    await recordOperation(tail.user, { entityType: 'routine', entityId: tail._id, snapshot: updated, opType: 'update', now });

    return newLink ? { ...summary, relinked: summary.relinked + 1 } : { ...summary, cleared: summary.cleared + 1 };
}

async function reduceSequential(tails: RoutineInterface[], opts: CliOptions, seed: Summary): Promise<Summary> {
    let acc = seed;
    for (const tail of tails) {
        acc = await correctOne(tail, opts, acc);
    }
    return acc;
}

async function run(): Promise<void> {
    const opts = parseArgs(process.argv.slice(2));
    await loadDataAccess();
    try {
        const scope = await resolveUserScope(opts);
        const tails = await routinesDAO.findArray({ ...scope, splitFromRoutineId: { $exists: true } });
        console.log(`Scanning ${tails.length} linked routine(s)${opts.dryRun ? ' (dry run)' : ''}.`);

        const seed: Summary = { scanned: tails.length, relinked: 0, cleared: 0, unchanged: 0 };
        const summary = await reduceSequential(tails, opts, seed);
        console.log(`Done. scanned=${summary.scanned} relinked=${summary.relinked} cleared=${summary.cleared} unchanged=${summary.unchanged}`);
    } finally {
        await closeDataAccess();
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
