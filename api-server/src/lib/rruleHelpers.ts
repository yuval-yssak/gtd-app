import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(utc);
dayjs.extend(customParseFormat);

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
