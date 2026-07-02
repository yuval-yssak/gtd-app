import { RRule } from 'rrule';
import type { StoredRoutine } from '../types/MyDB';
import { hasAtLeastOne } from './typeUtils';

export const FREQUENCY_BUCKETS = ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Annual'] as const;
export type FrequencyBucket = (typeof FREQUENCY_BUCKETS)[number];

const FREQ_BASE_DAYS = new Map<number, number>([
    [RRule.DAILY, 1],
    [RRule.WEEKLY, 7],
    [RRule.MONTHLY, 30],
    [RRule.YEARLY, 365],
]);

/** How many occurrences a single FREQ period yields (e.g. WEEKLY;BYDAY=MO,WE,FR → 3 per week). */
function occurrencesPerPeriod(freq: number, byweekday: number[] | null, bymonthday: number[] | null): number {
    if (freq === RRule.WEEKLY && byweekday && hasAtLeastOne(byweekday)) {
        return byweekday.length;
    }
    if (freq === RRule.MONTHLY && bymonthday && hasAtLeastOne(bymonthday)) {
        return bymonthday.length;
    }
    return 1;
}

/**
 * Approximate days between occurrences of an rrule — the sort key for frequency ordering.
 * Weekdays-only (~1.4d) lands near daily; "every 2 weeks" (14d) sorts after plain weekly (7d).
 * Unparseable rules sink to the bottom of the list rather than crashing.
 */
export function approxIntervalDays(rruleStr: string): number {
    try {
        // Dummy DTSTART so RRule.fromString can parse without error — same trick as formatRrule.
        const rule = RRule.fromString(`DTSTART:20240101T000000Z\nRRULE:${rruleStr}`);
        const { freq, interval = 1, byweekday, bymonthday } = rule.options;
        const base = FREQ_BASE_DAYS.get(freq) ?? 30;
        return (base * interval) / occurrencesPerPeriod(freq, byweekday, bymonthday);
    } catch {
        return Number.MAX_SAFE_INTEGER;
    }
}

// Bucket boundaries sit at the geometric midpoints between canonical intervals
// (1, 7, 30, 91, 365 days), so e.g. "every 3 days" reads as Weekly-ish, "every 2 weeks" stays Weekly.
const BUCKET_UPPER_BOUNDS: readonly [FrequencyBucket, number][] = [
    ['Daily', 2.6],
    ['Weekly', 14.5],
    ['Monthly', 52],
    ['Quarterly', 182],
    ['Annual', Number.POSITIVE_INFINITY],
];

export function frequencyBucket(intervalDays: number): FrequencyBucket {
    const match = BUCKET_UPPER_BOUNDS.find(([, upperBound]) => intervalDays < upperBound);
    return match ? match[0] : 'Annual';
}

export interface RoutineBucketGroup {
    bucket: FrequencyBucket;
    routines: StoredRoutine[];
}

export interface RoutineTypeSection {
    routineType: StoredRoutine['routineType'];
    title: string;
    buckets: RoutineBucketGroup[];
}

const TYPE_SECTIONS: readonly { routineType: StoredRoutine['routineType']; title: string }[] = [
    { routineType: 'nextAction', title: 'Next Action Routines' },
    { routineType: 'calendar', title: 'Calendar Routines' },
];

function sortByIntervalThenTitle(routines: StoredRoutine[]): StoredRoutine[] {
    return [...routines].sort((a, b) => approxIntervalDays(a.rrule) - approxIntervalDays(b.rrule) || a.title.localeCompare(b.title));
}

function bucketsFor(routines: StoredRoutine[]): RoutineBucketGroup[] {
    const sorted = sortByIntervalThenTitle(routines);
    return FREQUENCY_BUCKETS.map((bucket) => ({
        bucket,
        routines: sorted.filter((routine) => frequencyBucket(approxIntervalDays(routine.rrule)) === bucket),
    })).filter((group) => group.routines.length > 0);
}

/**
 * Group routines for the /routines page: Next Action routines first, then Calendar routines,
 * each divided into frequency buckets sorted daily → annual. Empty sections/buckets are omitted.
 */
export function groupRoutines(routines: StoredRoutine[]): RoutineTypeSection[] {
    return TYPE_SECTIONS.map(({ routineType, title }) => ({
        routineType,
        title,
        buckets: bucketsFor(routines.filter((routine) => routine.routineType === routineType)),
    })).filter((section) => hasAtLeastOne(section.buckets));
}

/** Case-insensitive substring match on the routine title; a blank query matches everything. */
export function filterRoutinesByTitle(routines: StoredRoutine[], query: string | undefined): StoredRoutine[] {
    const needle = query?.trim().toLowerCase();
    if (!needle) {
        return routines;
    }
    return routines.filter((routine) => routine.title.toLowerCase().includes(needle));
}
