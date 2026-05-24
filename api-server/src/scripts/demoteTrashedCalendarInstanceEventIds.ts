/**
 * Demotes legacy `trash`/`done` items that still carry `calendarInstanceEventId`. Such rows squat
 * the unique partial index slot `(user, calendarInstanceEventId)`, blocking a fresh live insert
 * when the active routine's exception sync runs. See `createItemForOrphanedException` in
 * `routes/calendar.ts` for the runtime-side fix; this script is a one-off backfill for occupants
 * that existed BEFORE the runtime fix shipped.
 *
 * `done` and `trash` rows legitimately keep `calendarInstanceEventId` going forward for echo
 * matching, but the live row that needs the slot is always the one the runtime fix demotes. The
 * backfill stripes only those rows whose slot is blocking nothing else (no live `calendar` row
 * shares the id — the unique index guarantees that anyway), so it is purely reclamation.
 *
 * Usage:
 *   cd api-server
 *   npx tsx --env-file=.env src/scripts/demoteTrashedCalendarInstanceEventIds.ts [options]
 *
 * Options:
 *   --user-email <email>  Scope to a single user. Default: all users with affected items.
 *   --apply               Persist changes. Without this flag, runs as a dry run (default).
 *
 * Records a sync `update` op per modified item so connected devices learn about the stripped field
 * on their next /sync/pull. Device id: `backfill:demote-trash-calendar-instance-event-ids`.
 *
 * Idempotent: re-running after a successful pass is a no-op (the query filters on the field's
 * presence).
 */

import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import type { Db } from 'mongodb';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import { closeDataAccess, loadDataAccess } from '../loaders/mainLoader.js';
import type { ItemInterface, OperationInterface } from '../types/entities.js';

const DEVICE_ID = 'backfill:demote-trash-calendar-instance-event-ids';

interface CliOptions {
    userEmail?: string;
    apply: boolean;
}

interface Summary {
    scanned: number;
    demoted: number;
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
    // Scope to users who have at least one dead row still holding an instance id.
    const usersWithDeadInstanceIds = await database
        .collection<{ user: string }>('items')
        .distinct('user' as never, { status: { $in: ['trash', 'done'] }, calendarInstanceEventId: { $type: 'string' } } as never);
    return usersWithDeadInstanceIds.map(String);
}

function buildDemotedSnapshot(item: ItemInterface, nowIso: string): ItemInterface {
    // Spread first to preserve every other field; explicit `{ ...item, calendarInstanceEventId: undefined }`
    // doesn't strip the key in the snapshot — we have to destructure.
    const { calendarInstanceEventId: _stripped, ...rest } = item;
    return { ...rest, updatedTs: nowIso };
}

async function demoteOne(item: ItemInterface, userId: string, summary: Summary): Promise<void> {
    const nowIso = dayjs().toISOString();
    const snapshot = buildDemotedSnapshot(item, nowIso);
    try {
        await itemsDAO.updateOne({ _id: item._id, user: userId } as never, { $unset: { calendarInstanceEventId: '' }, $set: { updatedTs: nowIso } });
    } catch (err) {
        summary.errors += 1;
        console.warn(`  ! updateOne failed for itemId=${item._id}: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }
    const op: OperationInterface = {
        _id: randomUUID(),
        user: userId,
        deviceId: DEVICE_ID,
        ts: nowIso,
        entityType: 'item',
        entityId: item._id ?? '',
        opType: 'update',
        snapshot,
    };
    try {
        await operationsDAO.insertOne(op);
    } catch (err) {
        summary.errors += 1;
        console.warn(`  ! operations.insertOne failed for itemId=${item._id}: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }
    summary.demoted += 1;
}

async function processUser(userId: string, opts: CliOptions, summary: Summary): Promise<void> {
    const items = await itemsDAO.findArray({
        user: userId,
        status: { $in: ['trash', 'done'] },
        calendarInstanceEventId: { $type: 'string' },
    } as never);
    summary.scanned += items.length;
    const verb = opts.apply ? 'demote' : 'would demote';
    console.log(`User ${userId}: ${items.length} dead row(s) to ${verb}.`);
    for (const item of items) {
        console.log(`  ${verb} itemId=${item._id} status=${item.status} instanceId=${item.calendarInstanceEventId} title="${item.title}"`);
        if (opts.apply) {
            await demoteOne(item, userId, summary);
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
        const summary: Summary = { scanned: 0, demoted: 0, errors: 0 };
        for (const userId of userIds) {
            await processUser(userId, opts, summary);
        }
        const plannedOrApplied = opts.apply ? `demoted=${summary.demoted}` : `wouldDemote=${summary.scanned}`;
        console.log(`Done. scanned=${summary.scanned} ${plannedOrApplied} errors=${summary.errors}${opts.apply ? '' : ' (dry run)'}`);
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
