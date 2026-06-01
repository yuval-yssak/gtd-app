import type { GoogleCalendar } from '../../api/calendarApi';

/**
 * Ordering for the "Choose a calendar to sync" picker:
 *   1. the primary calendar (always first, pre-selected),
 *   2. calendars the user owns/can write to ("Your calendars"),
 *   3. calendars shared with / subscribed to by the user ("Shared with you"),
 * alphabetical (locale-aware, case-insensitive) within each group. Google's raw `calendarList`
 * order is roughly subscription order, which is meaningless to the user — this makes the list
 * scannable and surfaces the most likely target up top.
 */

/** Access roles that mean the user can edit the calendar — treated as "your calendars". */
const OWNED_ROLES = new Set(['owner', 'writer']);

export type CalendarGroupKey = 'primary' | 'owned' | 'shared';

/** A picker row: either a non-selectable group header or a selectable calendar. */
export type CalendarPickerRow = { kind: 'header'; key: CalendarGroupKey; label: string } | { kind: 'calendar'; calendar: GoogleCalendar };

function groupOf(calendar: GoogleCalendar): CalendarGroupKey {
    if (calendar.primary) return 'primary';
    return OWNED_ROLES.has(calendar.accessRole) ? 'owned' : 'shared';
}

function byName(a: GoogleCalendar, b: GoogleCalendar): number {
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

/** Flat list of calendars in picker order (primary → owned → shared, A–Z within group). */
export function sortCalendars(calendars: GoogleCalendar[]): GoogleCalendar[] {
    const order: CalendarGroupKey[] = ['primary', 'owned', 'shared'];
    return order.flatMap((group) => calendars.filter((cal) => groupOf(cal) === group).sort(byName));
}

/** The id the picker should pre-select: the primary calendar if present, else the first sorted row. */
export function defaultCalendarId(calendars: GoogleCalendar[]): string | undefined {
    const [first] = sortCalendars(calendars);
    return first?.id;
}

const GROUP_LABELS: Record<Exclude<CalendarGroupKey, 'primary'>, string> = {
    owned: 'Your calendars',
    shared: 'Shared with you',
};

/**
 * Builds the ordered render rows for the picker, inserting a group header before the "owned" and
 * "shared" sections — but only when that section is non-empty AND there is more than one section to
 * disambiguate (a single homogeneous list needs no headers). The primary calendar never gets a header.
 */
export function buildCalendarPickerRows(calendars: GoogleCalendar[]): CalendarPickerRow[] {
    const sorted = sortCalendars(calendars);
    const presentGroups = new Set(sorted.map(groupOf));
    const needsHeaders = presentGroups.size > 1;
    return sorted.flatMap((calendar, index) => {
        const group = groupOf(calendar);
        const prev = sorted[index - 1];
        const isFirstOfGroup = !prev || groupOf(prev) !== group;
        const header = needsHeaders && isFirstOfGroup && group !== 'primary' ? [{ kind: 'header', key: group, label: GROUP_LABELS[group] } as const] : [];
        return [...header, { kind: 'calendar', calendar } as const];
    });
}
