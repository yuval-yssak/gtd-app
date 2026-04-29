/**
 * Deletes calendar items AND calendar routines from Google Calendar and the app's database.
 *
 * Cascade (all default; no flag to split them — a routine without its items is meaningless):
 *   1. Delete each routine's GCal master recurring event.
 *   2. Delete every routine-generated item from the app DB.
 *   3. Delete each stand-alone (non-routine) calendar item's GCal event, then the DB row.
 *   4. Delete the routines themselves from the app DB.
 *   - Every DB delete records a `delete` operation so other devices learn via sync pull.
 *
 * Usage:
 *   cd api-server
 *   npx tsx --env-file=.env src/scripts/deleteCalendarItems.ts --email <user-email> [options]
 *
 * Required:
 *   --email <email>            User whose calendar state to wipe.
 *
 * Optional filters (default: ALL calendar items + routines for the user):
 *   --from <ISO date>          Items only — timeStart >= this value. Does not filter routines.
 *   --until <ISO date>         Items only — timeStart <= this value. Does not filter routines.
 *   --integration-id <id>      Scope to this calendarIntegrationId (items AND routines).
 *   --calendar-id <id>         Scope to items/routines whose integration targets this Google calendarId.
 *   --dry-run                  List matches without deleting anything.
 *   --skip-gcal                Only delete from the app DB, leave GCal events intact.
 *   --skip-db                  Only delete from GCal, leave app rows intact.
 *
 * Leaves calendar integrations and sync configs untouched (so the OAuth connection survives).
 */

import dayjs from 'dayjs';
import type { Db, Filter } from 'mongodb';
import { type GoogleCalendarProvider, isGoogleApiError } from '../calendarProviders/GoogleCalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { buildCalendarProvider } from '../lib/buildCalendarProvider.js';
import { recordOperation } from '../lib/operationHelpers.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { CalendarIntegrationInterface, ItemInterface, RoutineInterface } from '../types/entities.js';

interface CliOptions {
    email: string;
    from?: string;
    until?: string;
    integrationId?: string;
    calendarId?: string;
    dryRun: boolean;
    skipGcal: boolean;
    skipDb: boolean;
}

interface ProviderEntry {
    provider: GoogleCalendarProvider;
    calendarId: string;
}

interface Summary {
    gcalDeleted: number;
    gcalSkipped: number;
    gcalFailed: number;
    dbItemsDeleted: number;
    dbRoutinesDeleted: number;
}

interface GCalResult {
    ok: boolean;
    reason?: string;
}

function parseArgs(argv: string[]): CliOptions {
    const get = (flag: string): string | undefined => {
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
    const has = (flag: string): boolean => argv.includes(flag);

    const email = get('--email');
    if (!email) {
        throw new Error('Missing required --email <user-email>');
    }
    const from = get('--from');
    const until = get('--until');
    const integrationId = get('--integration-id');
    const calendarId = get('--calendar-id');
    return {
        email,
        ...(from !== undefined ? { from } : {}),
        ...(until !== undefined ? { until } : {}),
        ...(integrationId !== undefined ? { integrationId } : {}),
        ...(calendarId !== undefined ? { calendarId } : {}),
        dryRun: has('--dry-run'),
        skipGcal: has('--skip-gcal'),
        skipDb: has('--skip-db'),
    };
}

/**
 * Better Auth users created via OAuth store `_id` as a MongoDB ObjectId, while test-seeded
 * users use a plain string. Items/routines always store `user` as the string hex form.
 * Coerce to string so downstream filters match regardless of which path created the user.
 */
async function findUserIdByEmail(database: Db, email: string): Promise<string> {
    const userDoc = await database.collection<{ _id: unknown; email: string }>('user').findOne({ email });
    if (!userDoc) {
        throw new Error(`No user found with email ${email}`);
    }
    return String(userDoc._id);
}

function buildTimeStartRange(opts: CliOptions): { $gte?: string; $lte?: string } | undefined {
    if (!opts.from && !opts.until) {
        return undefined;
    }
    return {
        ...(opts.from ? { $gte: opts.from } : {}),
        ...(opts.until ? { $lte: opts.until } : {}),
    };
}

function buildItemFilter(userId: string, opts: CliOptions, integrationIdAllowList: string[] | null): Filter<ItemInterface> {
    const timeStart = buildTimeStartRange(opts);
    const integrationIdFilter = opts.integrationId ?? (integrationIdAllowList ? { $in: integrationIdAllowList } : undefined);
    return {
        user: userId,
        status: 'calendar',
        ...(timeStart ? { timeStart } : {}),
        ...(integrationIdFilter ? { calendarIntegrationId: integrationIdFilter } : {}),
    };
}

function buildRoutineFilter(userId: string, opts: CliOptions, integrationIdAllowList: string[] | null): Filter<RoutineInterface> {
    const integrationIdFilter = opts.integrationId ?? (integrationIdAllowList ? { $in: integrationIdAllowList } : undefined);
    return {
        user: userId,
        // nextAction routines have no GCal presence; leave them alone. Only target routines
        // whose generated items are of status 'calendar'.
        routineType: 'calendar',
        ...(integrationIdFilter ? { calendarIntegrationId: integrationIdFilter } : {}),
    };
}

async function resolveIntegrations(userId: string, opts: CliOptions): Promise<{ integrations: CalendarIntegrationInterface[]; allowList: string[] | null }> {
    const all = await calendarIntegrationsDAO.findByUserDecrypted(userId);
    if (opts.integrationId) {
        const match = all.filter((i) => i._id === opts.integrationId);
        if (!match.length) {
            throw new Error(`No integration with id ${opts.integrationId} for this user`);
        }
        return { integrations: match, allowList: match.map((i) => i._id) };
    }
    if (opts.calendarId) {
        // Check both the deprecated integration.calendarId field (legacy rows) and the per-config
        // calendarId on CalendarSyncConfigInterface (Step 2+ rows). A match in either signals the
        // integration owns the requested calendar.
        const targetId = opts.calendarId;
        const matchedIntegrationIds = await collectIntegrationIdsForCalendar(all, targetId);
        const match = all.filter((i) => matchedIntegrationIds.has(i._id));
        if (!match.length) {
            throw new Error(`No integration targeting calendarId ${targetId} for this user`);
        }
        return { integrations: match, allowList: match.map((i) => i._id) };
    }
    return { integrations: all, allowList: null };
}

/** Returns the set of integrationIds whose legacy field OR sync-config calendarId matches the target. */
async function collectIntegrationIdsForCalendar(integrations: CalendarIntegrationInterface[], calendarId: string): Promise<Set<string>> {
    const matchedIds = new Set<string>();
    for (const integration of integrations) {
        if (integration.calendarId === calendarId) {
            matchedIds.add(integration._id);
            continue;
        }
        const configs = await calendarSyncConfigsDAO.findByIntegration(integration._id);
        if (configs.some((c) => c.calendarId === calendarId)) {
            matchedIds.add(integration._id);
        }
    }
    return matchedIds;
}

async function buildProviderMap(integrations: CalendarIntegrationInterface[], userId: string): Promise<Map<string, ProviderEntry>> {
    const entries = await Promise.all(
        integrations.map(async (i) => {
            const calendarId = await resolveProviderCalendarId(i);
            return [i._id, { provider: buildCalendarProvider(i, userId), calendarId }] as const;
        }),
    );
    return new Map(entries);
}

/**
 * Resolves the calendarId to use when calling GCal for an integration. Falls back to the default
 * sync config when the deprecated `integration.calendarId` field is absent (Step-2+ rows).
 * Throws if neither source has a value — the script can't operate on such an integration.
 */
async function resolveProviderCalendarId(integration: CalendarIntegrationInterface): Promise<string> {
    if (integration.calendarId) {
        return integration.calendarId;
    }
    const configs = await calendarSyncConfigsDAO.findByIntegration(integration._id);
    const defaultConfig = configs.find((c) => c.isDefault) ?? configs[0];
    if (!defaultConfig) {
        throw new Error(`Integration ${integration._id} has no calendarId — connect a calendar in settings first`);
    }
    return defaultConfig.calendarId;
}

async function deleteGCalEventForItem(item: ItemInterface, providers: Map<string, ProviderEntry>): Promise<GCalResult> {
    const { calendarEventId, calendarIntegrationId } = item;
    if (!calendarEventId || !calendarIntegrationId) {
        return { ok: true, reason: 'no-gcal-link' };
    }
    const entry = providers.get(calendarIntegrationId);
    if (!entry) {
        return { ok: false, reason: `integration ${calendarIntegrationId} not loaded` };
    }
    return callGCalDelete(() => entry.provider.deleteEvent(entry.calendarId, calendarEventId));
}

async function deleteGCalEventForRoutine(routine: RoutineInterface, providers: Map<string, ProviderEntry>): Promise<GCalResult> {
    const { calendarEventId, calendarIntegrationId } = routine;
    if (!calendarEventId || !calendarIntegrationId) {
        return { ok: true, reason: 'no-gcal-link' };
    }
    const entry = providers.get(calendarIntegrationId);
    if (!entry) {
        return { ok: false, reason: `integration ${calendarIntegrationId} not loaded` };
    }
    return callGCalDelete(() => entry.provider.deleteRecurringEvent(calendarEventId, entry.calendarId));
}

async function callGCalDelete(call: () => Promise<void>): Promise<GCalResult> {
    try {
        await call();
        return { ok: true };
    } catch (err: unknown) {
        // 404/410 — already gone on Google's side; treat as success.
        if (isGoogleApiError(err) && (err.code === 404 || err.code === 410)) {
            return { ok: true, reason: `gcal-already-gone (${err.code})` };
        }
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
}

function tallyGCal(summary: Summary, result: GCalResult): Summary {
    if (!result.ok) {
        return { ...summary, gcalFailed: summary.gcalFailed + 1 };
    }
    if (result.reason === 'no-gcal-link' || result.reason === 'skip-gcal') {
        return { ...summary, gcalSkipped: summary.gcalSkipped + 1 };
    }
    return { ...summary, gcalDeleted: summary.gcalDeleted + 1 };
}

// Sequential — GCal delete must succeed before DB delete, and Google rate-limits per user.
async function deleteOneItem(item: ItemInterface, opts: CliOptions, providers: Map<string, ProviderEntry>, userId: string, summary: Summary): Promise<Summary> {
    if (!item._id) {
        console.error(`  Skipping item with no _id: ${JSON.stringify(item)}`);
        return summary;
    }
    const gcal = opts.skipGcal ? ({ ok: true, reason: 'skip-gcal' } as GCalResult) : await deleteGCalEventForItem(item, providers);
    if (!gcal.ok) {
        console.error(`  GCal delete failed for item ${item._id}: ${gcal.reason}`);
        return tallyGCal(summary, gcal);
    }
    const tallied = tallyGCal(summary, gcal);
    if (opts.skipDb) {
        return tallied;
    }
    // Record op BEFORE DB delete — if we crash between, devices still learn of the delete on pull.
    await recordOperation(userId, { entityType: 'item', entityId: item._id, snapshot: null, opType: 'delete', now: dayjs().toISOString() });
    await itemsDAO.deleteByOwner(item._id, userId);
    return { ...tallied, dbItemsDeleted: tallied.dbItemsDeleted + 1 };
}

async function deleteOneRoutine(
    routine: RoutineInterface,
    opts: CliOptions,
    providers: Map<string, ProviderEntry>,
    userId: string,
    summary: Summary,
): Promise<Summary> {
    const gcal = opts.skipGcal ? ({ ok: true, reason: 'skip-gcal' } as GCalResult) : await deleteGCalEventForRoutine(routine, providers);
    if (!gcal.ok) {
        console.error(`  GCal delete failed for routine ${routine._id}: ${gcal.reason}`);
        return tallyGCal(summary, gcal);
    }
    const tallied = tallyGCal(summary, gcal);
    if (opts.skipDb) {
        return tallied;
    }
    await recordOperation(userId, { entityType: 'routine', entityId: routine._id, snapshot: null, opType: 'delete', now: dayjs().toISOString() });
    await routinesDAO.deleteByOwner(routine._id, userId);
    return { ...tallied, dbRoutinesDeleted: tallied.dbRoutinesDeleted + 1 };
}

async function reduceSequential<T>(source: T[], seed: Summary, step: (acc: Summary, value: T) => Promise<Summary>): Promise<Summary> {
    let acc = seed;
    for (const value of source) {
        acc = await step(acc, value);
    }
    return acc;
}

function logDryRun(items: ItemInterface[], routines: RoutineInterface[]): void {
    console.log(`Matched ${items.length} calendar item(s) and ${routines.length} routine(s) (dry run).`);
    for (const item of items) {
        console.log(
            `  [DRY item] ${item._id}  ${item.timeStart ?? '(no start)'}  "${item.title}"  routineId=${item.routineId ?? '-'}  gcal=${item.calendarEventId ?? '-'}`,
        );
    }
    for (const routine of routines) {
        console.log(`  [DRY routine] ${routine._id}  "${routine.title}"  active=${routine.active}  gcalMaster=${routine.calendarEventId ?? '-'}`);
    }
}

function logSummary(summary: Summary): void {
    console.log(
        `Done. GCal: ${summary.gcalDeleted} deleted, ${summary.gcalSkipped} skipped (no link), ${summary.gcalFailed} failed.` +
            ` DB: ${summary.dbItemsDeleted} item(s) deleted, ${summary.dbRoutinesDeleted} routine(s) deleted.`,
    );
}

async function deleteCalendarItemsAndRoutinesFor(opts: CliOptions): Promise<void> {
    const userId = await findUserIdByEmail(db, opts.email);
    console.log(`Resolved user ${opts.email} -> ${userId}`);

    const { integrations, allowList } = await resolveIntegrations(userId, opts);
    const providers = await buildProviderMap(integrations, userId);

    // findArray loads all matches into memory — fine for realistic GTD datasets (10²–10⁴ lifetime items per user).
    const [items, routines] = await Promise.all([
        itemsDAO.findArray(buildItemFilter(userId, opts, allowList)),
        routinesDAO.findArray(buildRoutineFilter(userId, opts, allowList)),
    ]);

    if (opts.dryRun) {
        logDryRun(items, routines);
        return;
    }
    console.log(`Matched ${items.length} calendar item(s) and ${routines.length} routine(s) for deletion.`);

    const seed: Summary = { gcalDeleted: 0, gcalSkipped: 0, gcalFailed: 0, dbItemsDeleted: 0, dbRoutinesDeleted: 0 };
    // Items before routines: if a routine-master GCal delete fails, we still clean most of the DB.
    // (Inverse order would risk leaving child items orphaned if the routine delete then failed later.)
    const afterItems = await reduceSequential(items, seed, (acc, item) => deleteOneItem(item, opts, providers, userId, acc));
    const afterRoutines = await reduceSequential(routines, afterItems, (acc, routine) => deleteOneRoutine(routine, opts, providers, userId, acc));
    logSummary(afterRoutines);
}

async function run(): Promise<void> {
    const opts = parseArgs(process.argv.slice(2));
    await loadDataAccess();
    try {
        await deleteCalendarItemsAndRoutinesFor(opts);
    } finally {
        await closeDataAccess();
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
