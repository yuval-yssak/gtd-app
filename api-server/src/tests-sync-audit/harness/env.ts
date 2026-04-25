import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SECRETS_PATH = resolve(__dirname, '../.secrets/gcal-e2e.json');

interface Secrets {
    refreshToken: string;
    calendarId: string;
    email: string;
    obtainedAt: string;
}

let cached: Secrets | null = null;

export function loadSecrets(): Secrets {
    if (cached) return cached;
    if (!existsSync(SECRETS_PATH)) {
        throw new Error(`Missing ${SECRETS_PATH}. Run: npx tsx src/tests-sync-audit/setupOAuth.ts`);
    }
    const parsed = JSON.parse(readFileSync(SECRETS_PATH, 'utf8')) as Secrets;
    if (!parsed.refreshToken || !parsed.calendarId) {
        throw new Error(`${SECRETS_PATH} is malformed — re-run setupOAuth.ts`);
    }
    cached = parsed;
    return parsed;
}

/** A unique prefix for this run's event summaries so cleanup can scope to only our events. */
export function makeRunId(): string {
    // Short — 8 hex chars is enough to distinguish runs within a day.
    return `e2esync-${Math.random().toString(16).slice(2, 10)}`;
}
