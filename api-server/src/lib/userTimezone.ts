import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import deviceSyncStateDAO from '../dataAccess/deviceSyncStateDAO.js';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * The user's IANA timezone as last reported by any of their devices — most recent report wins.
 * When the account is active in two timezones at once (two devices in parallel), the winner is
 * effectively arbitrary per generation event: SSE-driven pulls make both devices re-report on
 * every change, so whichever pulled last decides. The blast radius is a ±1-day stamp on
 * server-generated routine items during the hours the two calendar days disagree. Falls back to
 * UTC for users whose devices have never reported (pre-feature clients, public-API-only users) —
 * which matches legacy behavior only because production runs with TZ=UTC (Cloud Run default);
 * the pre-feature code stamped the SERVER-local day, not UTC per se.
 *
 * Re-validates the stored value: `dayjs().tz(garbage)` throws RangeError, the generators resolve
 * the timezone BEFORE their "generation must never fail the parent request" try blocks, and
 * pauseRoutine/resumeRoutine have no error handling at all — so the guard must live here, not at
 * the call sites. A bad row (manual mongosh edit, or a Node/ICU upgrade dropping an alias Intl
 * accepted at report time) must degrade to UTC, not 500 every routine create/complete for that user.
 */
export async function resolveUserTimezone(userId: string): Promise<string> {
    const rows = await deviceSyncStateDAO.findArray({ user: userId, timezone: { $exists: true } });
    // Secondary sort on _id: two rows can share a timezoneReportedTs (parallel pulls in the same
    // ms), and sort stability then leaves the winner to Mongo's unordered find() order —
    // resolution must not flap between two zones from call to call.
    const latest = rows.sort((a, b) => (b.timezoneReportedTs ?? '').localeCompare(a.timezoneReportedTs ?? '') || (b._id ?? '').localeCompare(a._id ?? ''))[0];
    const stored = latest?.timezone;
    if (stored !== undefined && !isValidIanaTimezone(stored)) {
        // Should be vanishingly rare (report-time validation) — make a silently-degraded user
        // visible in logs so "genuinely UTC" and "poisoned row" stay distinguishable.
        console.warn('[timezone] stored timezone is no longer valid; falling back to UTC', { userId, stored });
        return 'UTC';
    }
    return stored ?? 'UTC';
}

/** The user's local calendar date (YYYY-MM-DD) for `at` (default: now) in the given IANA timezone. */
export function localDateInTimezone(tz: string, at?: Date | string): string {
    return dayjs(at).tz(tz).format('YYYY-MM-DD');
}

/**
 * The user's local calendar day, offset by `days`. The offset is applied via `dayjs.utc` so the
 * date string arithmetic can never shift across a server-local DST boundary.
 */
export async function userLocalDate(userId: string, days = 0): Promise<string> {
    const localToday = localDateInTimezone(await resolveUserTimezone(userId));
    if (days === 0) {
        return localToday;
    }
    return dayjs.utc(localToday).add(days, 'day').format('YYYY-MM-DD');
}

/**
 * True when `tz` is resolvable by the Intl timezone database. Broader than strict `Region/City`
 * IANA names — fixed offsets ("+05:00"), legacy aliases ("US/Pacific"), and lowercase variants
 * all pass, and dayjs.tz handles every one of them. Validated via Intl rather than a regex —
 * the report is a raw client-supplied query param.
 */
export function isValidIanaTimezone(tz: string): boolean {
    if (tz.length === 0 || tz.length > 64) {
        return false;
    }
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}
