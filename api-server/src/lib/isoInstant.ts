import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(utc);
dayjs.extend(timezone);

/** Matches an explicit UTC (`Z`) or numeric-offset suffix on an ISO datetime string. */
const EXPLICIT_OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Millisecond instant of an ISO time string. Offset-naive strings (routine-generated rows store
 * wall-clock `timeStart` like `2026-08-16T07:00:00`) are interpreted in the calendar's timezone —
 * plain `dayjs()` would use the server's local zone (UTC on Cloud Run), skewing the comparison by
 * the zone offset and making every naive-vs-offset match silently miss.
 *
 * Shared by the exception-target resolver (calendar.ts `resolveByMovedInstant`) and the regeneration
 * pinning (routineItemRegeneration.ts): both decide "is this row the occurrence that exception moved"
 * by instant equality, and they must agree on what the same instant means.
 */
export function toInstant(time: string, timeZone: string | undefined): number {
    return EXPLICIT_OFFSET_RE.test(time) ? dayjs(time).valueOf() : dayjs.tz(time, timeZone ?? 'UTC').valueOf();
}
