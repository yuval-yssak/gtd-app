import dayjs from 'dayjs';
import { formatDisplayDate } from './displayDate';

/**
 * Human-friendly header for a tickler group, keyed by an `ignoreBefore` date (YYYY-MM-DD).
 * Self-contained: always includes the weekday + date, so callers must not append the date again.
 * The year is shown only when the date is not in the current year.
 */
export function ticklerDayLabel(dateStr: string, now = dayjs()) {
    const day = dayjs(dateStr).startOf('day');
    // Compare calendar days, not elapsed 24h spans — otherwise tomorrow reads as "Today" for most of today.
    const daysUntil = day.diff(now.startOf('day'), 'day');
    const date = formatDisplayDate(day, 'ddd, MMM D', now);
    if (daysUntil === 0) return `Today · ${date}`;
    if (daysUntil === 1) return `Tomorrow · ${date}`;
    return date;
}
