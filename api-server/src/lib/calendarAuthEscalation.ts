import dayjs from 'dayjs';
import { isInvalidGrantError } from '../calendarProviders/GoogleCalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import { buildCalendarAuthRevokedEmail, buildCalendarAuthWarningEmail } from './calendarAuthEmails.js';
import { integrationStatus } from './calendarIntegrationStatus.js';
import { sendEmail } from './emailStub.js';
import { getUserEmail } from './userLookup.js';

const DEFAULT_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

/**
 * Tunable grace window between the first detected `invalid_grant` and the integration being marked
 * `'revoked'`. Read at call time (not module init) so tests and dev verification can shrink it via
 * `CALENDAR_AUTH_GRACE_MS` without restarting the process.
 */
function gracePeriodMs(): number {
    const raw = process.env.CALENDAR_AUTH_GRACE_MS;
    if (!raw) {
        return DEFAULT_GRACE_PERIOD_MS;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        console.warn(`[calendar-auth] ignoring invalid CALENDAR_AUTH_GRACE_MS=${raw} — falling back to 24h`);
        return DEFAULT_GRACE_PERIOD_MS;
    }
    return parsed;
}

/**
 * Time-based state machine:
 *  - `'active'` (or no status field) → atomically transition to `'suspended'`, send warning email.
 *  - `'suspended'` for less than the grace window → bump `lastAuthErrorAt` only (no email).
 *  - `'suspended'` for at least the grace window → atomically transition to `'revoked'`, send final email.
 *  - `'revoked'` → no-op.
 *
 * Atomic CAS-style updates (`markSuspendedIfActive`, `markRevokedIfSuspended`) make this safe under
 * concurrent invocation — only the winner sends the email.
 */
export async function handleAuthFailure(integrationId: string): Promise<void> {
    const integration = await calendarIntegrationsDAO.findById(integrationId);
    if (!integration) {
        console.warn(`[calendar-auth] handleAuthFailure: integration ${integrationId} not found`);
        return;
    }
    const status = integrationStatus(integration);
    if (status === 'revoked') {
        console.log(`[calendar-auth] integration ${integrationId} already revoked — no-op`);
        return;
    }
    const now = dayjs().toISOString();
    if (status === 'active') {
        await escalateActiveToSuspended(integrationId, now);
        return;
    }
    // Suspended branch: decide between bump and revoke based on elapsed time.
    await escalateSuspended(integrationId, integration.suspendedAt, now);
}

async function escalateActiveToSuspended(integrationId: string, now: string): Promise<void> {
    const won = await calendarIntegrationsDAO.markSuspendedIfActive(integrationId, now);
    if (!won) {
        // Lost the race — another worker just suspended it. Recurse to fall through the suspended branch.
        console.log(`[calendar-auth] integration ${integrationId} lost suspend race — re-evaluating`);
        await handleAuthFailure(integrationId);
        return;
    }
    console.log(`[calendar-auth] suspended integration ${integrationId}`);
    const refreshed = await calendarIntegrationsDAO.findById(integrationId);
    if (!refreshed) {
        return;
    }
    const gracePeriodEndsAt = dayjs(now).add(gracePeriodMs(), 'millisecond').toISOString();
    const email = buildCalendarAuthWarningEmail(refreshed, gracePeriodEndsAt);
    await sendEscalationEmail({ userId: refreshed.user, kind: 'calendar_auth_warning', subject: email.subject, body: email.body });
}

async function escalateSuspended(integrationId: string, suspendedAt: string | undefined, now: string): Promise<void> {
    const elapsed = suspendedAt ? dayjs(now).diff(dayjs(suspendedAt)) : Number.POSITIVE_INFINITY;
    if (elapsed < gracePeriodMs()) {
        await calendarIntegrationsDAO.bumpLastAuthErrorAt(integrationId, now);
        console.log(`[calendar-auth] integration ${integrationId} still in grace (elapsed=${elapsed}ms) — bumped lastAuthErrorAt`);
        return;
    }
    const won = await calendarIntegrationsDAO.markRevokedIfSuspended(integrationId, now);
    if (!won) {
        // Lost the race — another worker just revoked it. Nothing left to do.
        console.log(`[calendar-auth] integration ${integrationId} lost revoke race — no-op`);
        return;
    }
    console.log(`[calendar-auth] revoked integration ${integrationId}`);
    const refreshed = await calendarIntegrationsDAO.findById(integrationId);
    if (!refreshed) {
        return;
    }
    const email = buildCalendarAuthRevokedEmail(refreshed);
    await sendEscalationEmail({ userId: refreshed.user, kind: 'calendar_auth_revoked', subject: email.subject, body: email.body });
}

interface EscalationEmail {
    userId: string;
    kind: 'calendar_auth_warning' | 'calendar_auth_revoked';
    subject: string;
    body: string;
}

async function sendEscalationEmail(args: EscalationEmail): Promise<void> {
    const to = await getUserEmail(args.userId);
    if (!to) {
        console.warn(`[calendar-auth] cannot send ${args.kind} — no email for user ${args.userId}`);
        return;
    }
    await sendEmail({ userId: args.userId, to, subject: args.subject, body: args.body, kind: args.kind });
}

/**
 * Wraps a provider call so that a thrown `invalid_grant` error fires the escalation state machine
 * as a side effect. The original error is always re-thrown so callers' existing handlers (HTTP
 * response, per-loop swallow, etc.) remain in charge. Handler-level error responses are unchanged
 * by this wrapper — it only adds the side effect.
 */
export async function withAuthFailureHandling<T>(integrationId: string, fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (err) {
        if (isInvalidGrantError(err)) {
            // Fire-and-forget: never let the side effect mask or replace the original failure.
            handleAuthFailure(integrationId).catch((escalationErr) => {
                console.error(`[calendar-auth] handleAuthFailure threw for integration ${integrationId}:`, escalationErr);
            });
        }
        throw err;
    }
}
