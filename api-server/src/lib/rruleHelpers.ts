import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import utc from 'dayjs/plugin/utc.js';
import rrule from 'rrule';

dayjs.extend(utc);
dayjs.extend(customParseFormat);

// rrule@2.8.1 ships CJS as `main`; default-import + destructure works across Node ESM/Vitest.
const { RRule } = rrule;

/**
 * Convert an RFC 5545 UNTIL value (compact format) to an ISO datetime string.
 * Handles both datetime (20260410T090000Z) and bare date (20260410) forms.
 * Bare dates are interpreted as UTC midnight.
 */
function parseRfc5545DateTime(raw: string): string | null {
    const isDateOnly = /^\d{8}$/.test(raw);
    const parsed = isDateOnly ? dayjs.utc(raw, 'YYYYMMDD') : dayjs.utc(raw, 'YYYYMMDDTHHmmss[Z]');
    if (!parsed.isValid()) return null;
    return parsed.toISOString();
}

/** Parse the UNTIL value from an rrule string and return it as an ISO datetime. */
export function extractUntilFromRrule(rrule: string): string | null {
    const match = rrule.match(/UNTIL=([^;]+)/);
    if (!match?.[1]) return null;
    return parseRfc5545DateTime(match[1]);
}

/**
 * Thrown by `computeNextOccurrence` when the rrule series has no further occurrences (UNTIL/COUNT
 * exhausted). Callers (server-side routine item generation) catch this to deactivate the routine
 * rather than logging a generic error. Mirrors the client-side `RruleExhaustedError`.
 */
export class RruleExhaustedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RruleExhaustedError';
    }
}

/**
 * Parse an rrule string (without DTSTART) into an RRule instance anchored to a given date.
 * Mirrors `client/src/lib/rruleUtils.ts:parseRrule` — DTSTART is embedded in the rrule string
 * (rather than spread via options) so byhour/byminute/bysecond do not inherit the wall-clock time.
 */
function parseRrule(rruleStr: string, dtstart: Date): InstanceType<typeof RRule> {
    const dtStartStr = `${dayjs(dtstart).utc().format('YYYYMMDDTHHmmss')}Z`;
    return RRule.fromString(`DTSTART:${dtStartStr}\nRRULE:${rruleStr}`);
}

/**
 * Return the first rrule occurrence at or after `afterDate`. Mirrors the client-side function of
 * the same name (`client/src/lib/rruleUtils.ts`) so server- and client-generated routine items
 * land on the same dates.
 * - `includeAnchor=false` (default): strictly after — used after item completion so a same-day
 *   completion advances to the next occurrence.
 * - `includeAnchor=true`: the anchor itself counts — used when generating the *first* item for a
 *   brand-new routine so a daily/interval rule lands today rather than tomorrow.
 *
 * Throws `RruleExhaustedError` when the series has no occurrence after `afterDate`.
 */
export function computeNextOccurrence(rruleStr: string, afterDate: Date, includeAnchor = false): Date {
    const rule = parseRrule(rruleStr, afterDate);
    const next = rule.after(afterDate, includeAnchor);
    if (!next) {
        throw new RruleExhaustedError(`rrule "${rruleStr}" has no occurrence after ${dayjs(afterDate).toISOString()}`);
    }
    return next;
}
