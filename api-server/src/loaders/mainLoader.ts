import { MongoClient } from 'mongodb';
import { mongoDBConfig } from '../config.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import refreshTokensDAO from '../dataAccess/refreshTokensDAO.js';
import usersDAO from '../dataAccess/usersDAO.js';

let dbClient: MongoClient;

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
    await usersDAO.init(dbClient, resolvedDBName);
    await itemsDAO.init(dbClient, resolvedDBName);
    await refreshTokensDAO.init(dbClient, resolvedDBName);
}

async function closeDataAccess() {
    await dbClient.close();
    console.log('MongoDB: Connection successfully closed');
}

export { closeDataAccess, loadDataAccess };
