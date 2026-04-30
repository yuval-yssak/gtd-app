import { type Db, MongoClient } from 'mongodb';
import { type Auth, createAuth } from '../auth/betterAuth.js';
import { mongoDBConfig } from '../config.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import deviceSyncStateDAO from '../dataAccess/deviceSyncStateDAO.js';
import deviceUsersDAO from '../dataAccess/deviceUsersDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import peopleDAO from '../dataAccess/peopleDAO.js';
import pushSubscriptionsDAO from '../dataAccess/pushSubscriptionsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import workContextsDAO from '../dataAccess/workContextsDAO.js';
import { migrateDeviceSyncStateToPerUserCursor } from './deviceSyncStateMigration.js';

// Assigned in loadDataAccess(); kept as let so closeDataAccess() can close it
let dbClient: MongoClient;

// Exported as live ESM bindings — assigned inside loadDataAccess() before any requests are served
export let auth!: Auth;
export let db!: Db;

async function mongoConnect() {
    const client = new MongoClient(mongoDBConfig.DBUrl);
    await client.connect();

    // Strip password from URL before logging
    console.log('MongoDB: Connected successfully to server', mongoDBConfig.DBUrl.replace(/:\w+@/, '@'));

    return client;
}

async function loadDataAccess(customDBName?: string) {
    const resolvedDBName = customDBName ?? mongoDBConfig.dbName;

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
    ]);
    // Convert any legacy single-cursor-per-device rows to per-(device, user) shape.
    // Idempotent + boot-only — see deviceSyncStateMigration.ts.
    await migrateDeviceSyncStateToPerUserCursor(db);
    auth = createAuth(db);
}

async function closeDataAccess() {
    await dbClient.close();
    console.log('MongoDB: Connection successfully closed');
}

export { closeDataAccess, loadDataAccess };
