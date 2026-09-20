// dotenv is loaded in index.ts via `import 'dotenv/config'` — just read process.env here
export const mongoDBConfig = {
    dbName: process.env.MONGO_DB_NAME ?? '',
    DBUrl: process.env.MONGO_DB_URL ?? '',
};

export const clientUrl = process.env.CLIENT_URL ?? 'http://localhost:4173';

/**
 * `BRIEF_FAKE_MODEL=1` makes brief generation return a deterministic stand-in instead of calling
 * Anthropic (e2e only — see lib/brief/briefModel.ts). `index.ts` calls this at boot so the server
 * refuses to start with the flag under production and a copied env file can never ship fake
 * briefs to real users. A boot-time call (not an import side effect) keeps the failure legible.
 */
export function assertBriefFakeModelNotInProduction(env: { NODE_ENV?: string; BRIEF_FAKE_MODEL?: string }): void {
    if (env.NODE_ENV === 'production' && env.BRIEF_FAKE_MODEL === '1') {
        throw new Error('BRIEF_FAKE_MODEL=1 is a test-only flag and must not be set in production');
    }
}
