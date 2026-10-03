import dayjs from 'dayjs';

/**
 * Pure helpers behind the DateField picker popover. Every date is a local-calendar `YYYY-MM-DD`
 * string — the same shape the native `<input type="date">` emits — so the popover and the typed
 * input write identical values into form state.
 */

const ISO_DAY = 'YYYY-MM-DD';

export interface QuickDatePick {
    label: string;
    date: string;
}

/** First day of the month containing `dayIso` (or today when the field is empty). */
export function startOfMonthIso(dayIso: string, todayIso: string): string {
    const anchor = dayIso ? dayjs(dayIso) : dayjs(todayIso);
    return anchor.startOf('month').format(ISO_DAY);
}

export function shiftMonth(monthIso: string, deltaMonths: number): string {
    return dayjs(monthIso).add(deltaMonths, 'month').startOf('month').format(ISO_DAY);
}

/**
 * Six locale-aligned weeks covering the month — always six so the popover never changes height
 * while the user pages through months. Leading/trailing days belong to the neighbouring months.
 */
export function monthGridWeeks(monthIso: string): string[][] {
    const gridStart = dayjs(monthIso).startOf('month').startOf('week');
    return Array.from({ length: 6 }, (_, week) => Array.from({ length: 7 }, (_, day) => gridStart.add(week * 7 + day, 'day').format(ISO_DAY)));
}

/** Two-letter weekday headers in the locale's week order (Su … Sa for `en`). */
export function weekdayLabels(): string[] {
    const weekStart = dayjs().startOf('week');
    return Array.from({ length: 7 }, (_, day) => weekStart.add(day, 'day').format('dd'));
}

export function isInMonth(dayIso: string, monthIso: string): boolean {
    return dayjs(dayIso).isSame(dayjs(monthIso), 'month');
}

/** The Monday strictly after today — "next Monday" even when today is a Monday. */
function nextMondayIso(today: dayjs.Dayjs): string {
    const daysAhead = (1 - today.day() + 7) % 7 || 7;
    return today.add(daysAhead, 'day').format(ISO_DAY);
}

/** One-tap targets for the deferral dates GTD leans on — tomorrow, Monday, a week, a month. */
export function quickDatePicks(todayIso: string): QuickDatePick[] {
    const today = dayjs(todayIso);
    return [
        { label: 'Today', date: today.format(ISO_DAY) },
        { label: 'Tomorrow', date: today.add(1, 'day').format(ISO_DAY) },
        { label: 'Next Mon', date: nextMondayIso(today) },
        { label: 'In a week', date: today.add(1, 'week').format(ISO_DAY) },
        { label: 'In a month', date: today.add(1, 'month').format(ISO_DAY) },
    ];
}

/** Full accessible name for a day cell, e.g. "Thursday, October 15, 2026". */
export function dayCellLabel(dayIso: string): string {
    return dayjs(dayIso).format('dddd, MMMM D, YYYY');
}

export function monthHeading(monthIso: string): string {
    return dayjs(monthIso).format('MMMM YYYY');
}

export function dayOfMonth(dayIso: string): number {
    return dayjs(dayIso).date();
}
