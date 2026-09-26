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

/**
 * Better Auth signs every session cookie with `BETTER_AUTH_SECRET`; `auth/betterAuth.ts` falls back
 * to a public dev placeholder when it is unset, which in production would let anyone forge a session.
 * `index.ts` calls this at boot so a deploy with the secret missing — or blank: deploy-api.yml writes
 * every GitHub secret through verbatim, and an unset one arrives as '' — fails loudly instead of serving.
 */
export function assertSessionSecretConfiguredInProduction(env: { NODE_ENV?: string; BETTER_AUTH_SECRET?: string }) {
    if (env.NODE_ENV === 'production' && !env.BETTER_AUTH_SECRET?.trim()) {
        throw new Error('BETTER_AUTH_SECRET must be set in production — sessions would otherwise be signed with the public dev placeholder');
    }
}

/**
 * The in-process webhook-renewal timer exists for environments without Cloud Scheduler (local dev).
 * Deployed instances scale to zero, so a timer could never be relied on there anyway; Cloud Scheduler
 * drives `POST /calendar/webhooks/renew` instead (docs/gcp-deploy-plan.md), and running both would
 * only double the Google API traffic on every cold start. `CRON_SECRET` is the tell that a Scheduler
 * job can be driving renewal: `requireCronSecret` rejects every caller while it is unset, so a
 * production deploy that has not been provisioned yet keeps the timer as its only (best-effort)
 * renewal path instead of letting every watch channel lapse.
 */
export function shouldStartWebhookRenewalTimer(env: { NODE_ENV?: string; CALENDAR_WEBHOOK_URL?: string; CRON_SECRET?: string }) {
    if (!env.CALENDAR_WEBHOOK_URL) {
        return false;
    }
    return env.NODE_ENV !== 'production' || !env.CRON_SECRET;
}
