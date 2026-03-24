import { type Db, MongoClient } from 'mongodb';
import { type Auth, createAuth } from '../auth/betterAuth.js';
import { mongoDBConfig } from '../config.js';
import itemsDAO from '../dataAccess/itemsDAO.js';

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
    await itemsDAO.init(dbClient, resolvedDBName);
    auth = createAuth(db);
}

async function closeDataAccess() {
    await dbClient.close();
    console.log('MongoDB: Connection successfully closed');
}

export { closeDataAccess, loadDataAccess };
