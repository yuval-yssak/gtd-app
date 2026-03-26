// dotenv is loaded in index.ts via `import 'dotenv/config'` — just read process.env here
export const mongoDBConfig = {
    dbName: process.env.MONGO_DB_NAME ?? '',
    DBUrl: process.env.MONGO_DB_URL ?? '',
};

export const clientUrl = process.env.CLIENT_URL ?? 'http://localhost:4173';
