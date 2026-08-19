import { isGoogleApiError, isInvalidGrantError } from '../calendarProviders/GoogleCalendarProvider.js';
import type { OpFailureReason } from '../types/entities.js';

/**
 * Maps a GCal API error (or anything thrown by the provider) to the OpFailureReason enum the
 * SyncIssuesPanel surfaces. The categorization is what drives the panel's per-row remediation
 * action (Reconnect, Pick calendar, Resolve conflict, Dismiss).
 *
 * Buckets:
 *  - `scope_missing`   → token revoked / invalid_grant / lost write scope. Panel asks the user to
 *                        re-consent.
 *  - `terminal`        → 404/410 (event gone), 403 (uninvited / attendee mutation rejected). No
 *                        retry will help; panel shows Dismiss only. EXCEPT rate-limit 403s — see
 *                        `isRateLimit403` — which are retryable and bucket as transient_exhausted.
 *  - `calendar_missing`→ 404 on the calendar resource itself. Panel asks the user to pick a calendar.
 *                        Currently differentiated from generic 404 only by caller intent — callers
 *                        that want this discrimination must categorize before invoking this helper,
 *                        since the wire-format error doesn't distinguish event-404 from calendar-404.
 *  - `edit_conflict`   → 409. Panel offers Retry after surfacing the conflict.
 *  - `transient_exhausted` → 5xx / 429 / network — but only AFTER `retryWithBackoff` has burned its
 *                            three attempts. Panel offers Retry.
 *
 * Everything that doesn't match a bucket bucket falls back to `'transient_exhausted'` — safest
 * default since the panel shows a Retry button there and "unknown but maybe transient" is closer to
 * truth than "terminal, dismiss forever".
 */
export function categorizeGCalError(err: unknown): OpFailureReason {
    if (isInvalidGrantError(err)) {
        return 'scope_missing';
    }
    if (!isGoogleApiError(err)) {
        return 'transient_exhausted';
    }
    const { code } = err;
    if (code === 404 || code === 410) {
        return 'terminal';
    }
    if (code === 403) {
        return isRateLimit403(err) ? 'transient_exhausted' : 'terminal';
    }
    if (code === 409) {
        return 'edit_conflict';
    }
    if (code >= 500 || code === 429) {
        return 'transient_exhausted';
    }
    return 'transient_exhausted';
}

/**
 * Google's short-window per-user write quota surfaces as HTTP 403 (not 429!) with reason
 * `rateLimitExceeded` / `userRateLimitExceeded` and message "Rate Limit Exceeded". Unlike the
 * other 403s (uninvited, attendee mutation rejected), it clears on its own — bucketing it as
 * `terminal` would render a burst-trash failure Dismiss-only instead of Retry-able. Checks the
 * structured `errors[].reason` list first and falls back to the message, covering both shapes
 * googleapis has been observed to throw.
 */
function isRateLimit403(err: Error & { code: number }): boolean {
    // Deliberately NOT matched: `dailyLimitExceeded` / `quotaExceeded` — those are long-window
    // (daily) quotas where a Retry affordance would be misleading; only the short-window
    // per-user write limiter clears fast enough for the panel's Retry to make sense.
    const nestedErrors = (err as { errors?: Array<{ reason?: unknown }> }).errors ?? [];
    if (nestedErrors.some((nested) => nested.reason === 'rateLimitExceeded' || nested.reason === 'userRateLimitExceeded')) {
        return true;
    }
    return err.message.toLowerCase().includes('rate limit exceeded');
}
