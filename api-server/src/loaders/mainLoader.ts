import { type Db, MongoClient } from 'mongodb';
import { type Auth, createAuth } from '../auth/betterAuth.js';
import { mongoDBConfig } from '../config.js';
import apiTokensDAO from '../dataAccess/apiTokensDAO.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import claudeUsageDAO from '../dataAccess/claudeUsageDAO.js';
import deviceSyncStateDAO from '../dataAccess/deviceSyncStateDAO.js';
import deviceUsersDAO from '../dataAccess/deviceUsersDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import oauthAuthCodesDAO from '../dataAccess/oauthAuthCodesDAO.js';
import oauthClientsDAO from '../dataAccess/oauthClientsDAO.js';
import oauthRefreshTokensDAO from '../dataAccess/oauthRefreshTokensDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import peopleDAO from '../dataAccess/peopleDAO.js';
import pushSubscriptionsDAO from '../dataAccess/pushSubscriptionsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import sentEmailsDAO from '../dataAccess/sentEmailsDAO.js';
import webhookDeliveriesDAO from '../dataAccess/webhookDeliveriesDAO.js';
import webhookSubscriptionsDAO from '../dataAccess/webhookSubscriptionsDAO.js';
import workContextsDAO from '../dataAccess/workContextsDAO.js';
import { migrateLegacyClarifyScope } from './apiTokenScopeMigration.js';
import { dedupeCalendarItemsPerEvent } from './calendarItemDuplicateMigration.js';
import { migrateDeviceSyncStateToPerUserCursor } from './deviceSyncStateMigration.js';
import { dedupeActiveRoutinesPerGCalSeries } from './routineDuplicateMigration.js';

// Assigned in loadDataAccess(); kept as let so closeDataAccess() can close it
let dbClient: MongoClient;

// Exported as live ESM bindings — assigned inside loadDataAccess() before any requests are served
export let auth!: Auth;
export let db!: Db;

// Under vitest the api-server unit suite, the client suite, and the e2e suite (which boots its own
// api-server against the same local Mongo) can all run at once via the stop-hook. That saturation
// made the driver's server-monitor heartbeat time out and clear the pool mid-query
// (PoolClearedOnNetworkError / "server monitor timeout"), failing otherwise-passing tests. Widen the
// monitor + selection budgets and lean on retryable reads/writes ONLY in tests, so a transient stall
// under load is ridden out instead of killing in-flight operations. Production keeps the driver
// defaults (no behavior change off the test path).
function mongoClientOptions() {
    if (process.env.NODE_ENV !== 'test') return undefined;
    return {
        serverSelectionTimeoutMS: 60_000,
        heartbeatFrequencyMS: 30_000,
        socketTimeoutMS: 60_000,
        retryReads: true,
        retryWrites: true,
    } as const;
}

async function mongoConnect() {
    const client = new MongoClient(mongoDBConfig.DBUrl, mongoClientOptions());
    await client.connect();

    // Strip password from URL before logging
    console.log('MongoDB: Connected successfully to server', mongoDBConfig.DBUrl.replace(/:\w+@/, '@'));

    return client;
}

// Under vitest, namespace each test DB by the runner's parent PID so two concurrent `npm run test`
// processes (e.g. a manual run racing the stop-hook's parallel api-server check) never share a
// `gtd_test` database and wipe each other's collections in beforeEach. `process.ppid` is identical
// across all worker processes of one run but differs between separate runs — exactly the
// stable-within-run, unique-across-runs token we need, with no per-test-file plumbing.
function namespaceTestDB(name: string) {
    if (process.env.NODE_ENV !== 'test') return name;
    return `${name}_p${process.ppid}`;
}

async function loadDataAccess(customDBName?: string) {
    const resolvedDBName = namespaceTestDB(customDBName ?? mongoDBConfig.dbName);

    dbClient = await mongoConnect();
    db = dbClient.db(resolvedDBName);
    await Promise.all([
        itemsDAO.init(dbClient, resolvedDBName),
        operationsDAO.init(dbClient, resolvedDBName),
        deviceSyncStateDAO.init(dbClient, resolvedDBName),
        deviceUsersDAO.init(dbClient, resolvedDBName),
        pushSubscriptionsDAO.init(dbClient, resolvedDBName),
        routinesDAO.init(dbClient, resolvedDBName),
        peopleDAO.init(dbClient, resolvedDBName),
        workContextsDAO.init(dbClient, resolvedDBName),
        calendarIntegrationsDAO.init(dbClient, resolvedDBName),
        calendarSyncConfigsDAO.init(dbClient, resolvedDBName),
        sentEmailsDAO.init(dbClient, resolvedDBName),
        apiTokensDAO.init(dbClient, resolvedDBName),
        webhookSubscriptionsDAO.init(dbClient, resolvedDBName),
        webhookDeliveriesDAO.init(dbClient, resolvedDBName),
        claudeUsageDAO.init(dbClient, resolvedDBName),
        oauthClientsDAO.init(dbClient, resolvedDBName),
        oauthAuthCodesDAO.init(dbClient, resolvedDBName),
        oauthRefreshTokensDAO.init(dbClient, resolvedDBName),
    ]);
    // Persist the legacy items.clarify → items.write scope rewrite so stored tokens match what auth
    // enforces (the in-memory backfill bridge has been removed). Idempotent + boot-only.
    await migrateLegacyClarifyScope(db);
    // Convert any legacy single-cursor-per-device rows to per-(device, user) shape.
    // Idempotent + boot-only — see deviceSyncStateMigration.ts.
    await migrateDeviceSyncStateToPerUserCursor(db);
    // Collapse any duplicate active routines on the same GCal series, THEN build the unique index that
    // forbids them. Order matters: the index build would crash boot if violating data still existed.
    await dedupeActiveRoutinesPerGCalSeries(db);
    await routinesDAO.ensureUniqueActiveSeriesIndex();
    // Same dedupe-then-index ordering for standalone calendar items: collapse duplicate live items on
    // the same GCal event before building the unique index that forbids them.
    await dedupeCalendarItemsPerEvent(db);
    await itemsDAO.ensureUniqueCalendarEventIndex();
    auth = createAuth(db);
}

async function closeDataAccess() {
    await dbClient.close();
    console.log('MongoDB: Connection successfully closed');
}

export { closeDataAccess, loadDataAccess };
