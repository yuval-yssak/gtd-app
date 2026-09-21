import { timingSafeEqual } from 'node:crypto';
import { createMiddleware } from 'hono/factory';

/**
 * Shared-secret gate for endpoints driven by Cloud Scheduler (calendar webhook renewal, the brief
 * sweep). The job sends `x-cron-secret`; the value must equal `CRON_SECRET` (a GitHub environment
 * secret → Cloud Run env var, see docs/gcp-deploy-plan.md). An unset env var rejects EVERY caller
 * with the same 401 as a mismatch — an empty deploy must fail closed, and a distinct status would
 * tell a probe that the endpoint exists but is unconfigured.
 */
export const CRON_SECRET_HEADER = 'x-cron-secret';

/** Constant-time equality so the comparison never leaks how much of a guess matched. */
function secretsMatch(provided: string, expected: string): boolean {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

export function isCronSecretValid(provided: string | undefined, expected: string | undefined): boolean {
    return !!provided && !!expected && secretsMatch(provided, expected);
}

export function requireCronSecret() {
    return createMiddleware(async (c, next) => {
        if (!isCronSecretValid(c.req.header(CRON_SECRET_HEADER), process.env.CRON_SECRET)) {
            return c.text('Unauthorized', 401);
        }
        return next();
    });
}
