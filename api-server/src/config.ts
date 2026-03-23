// dotenv is loaded in index.ts via `import 'dotenv/config'` — just read process.env here
export const mongoDBConfig = {
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation here
    dbName: process.env['MONGO_DB_NAME'] ?? '',
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation here
    DBUrl: process.env['MONGO_DB_URL'] ?? '',
};

// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation here
export const clientUrl = process.env['CLIENT_URL'] ?? 'http://localhost:5173';
