/**
 * Pure helpers behind RoutineReviewCard. Render-free so they unit-test under vitest's
 * `environment: 'node'` (the project has no jsdom — see vitest.config.ts).
 */
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { formatAllDayDate, fromGCalExclusive } from '../../lib/allDayDate';
import { findRoutineNextItem } from '../../lib/routineNextItem';
import type { StoredItem, StoredRoutine } from '../../types/MyDB';
import { isMultiDayAllDay } from '../calendarRouteSort';
import { isModifiedExceptionItem } from './reviewFlowState';

dayjs.extend(relativeTime);

/** The occurrences this card stands for: the routine's calendar items minus modified exceptions (those review on their own). */
export function collapsedOccurrences(routine: StoredRoutine, allItems: ReadonlyArray<StoredItem>): StoredItem[] {
    return allItems
        .filter((item) => item.routineId === routine._id && item.status === 'calendar' && !isModifiedExceptionItem(routine, item))
        .sort((a, b) => (a.timeStart ?? '').localeCompare(b.timeStart ?? ''));
}

/**
 * The occurrence whose date the calendar stage SORTED this entry by: the first still-open one.
 * `compareCalendarItems` ranks a routine entry by its earliest occurrence, so leading the card
 * with any other date would contradict the position the entry holds in the walk.
 */
export function sortAnchorOccurrence(occurrences: ReadonlyArray<StoredItem>): StoredItem | undefined {
    return occurrences.find((occurrence) => occurrence.timeStart !== undefined) ?? occurrences[0];
}

/**
 * The occurrence a "Mark done" on this card completes — deliberately NOT the sort anchor. The card
 * is positioned in the walk by its EARLIEST occurrence, but the event the user is actually being
 * asked about is the one `findRoutineNextItem` surfaces everywhere else (the routine page, the
 * routines list): the soonest upcoming one, or the most recent overdue one when all are past.
 * Completing anything else would silently finish a different event than the routine page offers.
 */
export function actionableOccurrence(routine: StoredRoutine, occurrences: ReadonlyArray<StoredItem>, now = dayjs()): StoredItem | undefined {
    const result = findRoutineNextItem(routine, [...occurrences], now);
    return result.item ?? undefined;
}

/**
 * The date/time headline, formatted exactly like a one-off calendar entry reads. Deliberately
 * defers to the /calendar page's conventions rather than inventing its own: `h:mm a` for times
 * (the format `TimeColumn` in routes/_authenticated/calendar.tsx renders), and the shared
 * all-day helpers for dates — `timeEnd` is GCal-EXCLUSIVE, so a multi-day all-day range must go
 * through `fromGCalExclusive` or it reads one day long. Empty when the occurrence carries no
 * start (a series with nothing generated yet).
 */
export function formatOccurrenceWhen(occurrence: StoredItem | undefined): string {
    if (!occurrence?.timeStart) {
        return '';
    }
    if (occurrence.allDay) {
        return formatAllDayWhen(occurrence);
    }
    const start = dayjs(occurrence.timeStart);
    const endPart = occurrence.timeEnd ? ` – ${dayjs(occurrence.timeEnd).format('h:mm a')}` : '';
    return `${start.format('ddd, MMM D')} · ${start.format('h:mm a')}${endPart}`;
}

/** All-day headline: a single date, or the inclusive range for a multi-day occurrence. */
function formatAllDayWhen(occurrence: StoredItem): string {
    const startLabel = formatAllDayDate(occurrence.timeStart ?? '', 'ddd, MMM D');
    if (!isMultiDayAllDay(occurrence) || !occurrence.timeEnd) {
        return `${startLabel} · all day`;
    }
    return `${startLabel} – ${formatAllDayDate(fromGCalExclusive(occurrence.timeEnd), 'ddd, MMM D')} · all day`;
}

/**
 * "in 3 days" / "today" / "2 weeks ago" — the relative cue next to the date. All-day occurrences
 * are compared at DAY granularity: a bare YYYY-MM-DD parses to local midnight, so `from(now)` on
 * tomorrow's all-day event would read "in 9 hours" rather than "in a day".
 */
export function formatOccurrenceRelative(occurrence: StoredItem | undefined, now = dayjs()): string {
    if (!occurrence?.timeStart) {
        return '';
    }
    const start = dayjs(occurrence.timeStart);
    if (start.isSame(now, 'day')) {
        return 'today';
    }
    return occurrence.allDay ? start.startOf('day').from(now.startOf('day')) : start.from(now);
}

/**
 * The routine's remaining-occurrence tail, phrased as context UNDER the headline date rather than
 * as the headline itself: the card leads with a concrete date like a one-off, then says how the
 * rest of the series repeats.
 */
export function occurrenceSummary(occurrences: ReadonlyArray<StoredItem>, anchor: StoredItem | undefined): string {
    const total = occurrences.length;
    const others = anchor ? total - 1 : total;
    const scheduled = `${total} occurrence${total === 1 ? '' : 's'} on the calendar`;
    if (others <= 0) {
        return scheduled;
    }
    return `${scheduled} · ${others} more after this one`;
}

/**
 * GCal-owned meeting metadata lives on the ROUTINE (the series master) while location / meeting
 * link mirror per-occurrence onto items. Project both onto one item-shaped value so the routine
 * card can drive the very same `CalendarEventLinks` / `MeetingDetails` components a one-off uses,
 * instead of re-implementing a parallel presentation. Routine fields win only where the
 * occurrence has none, so a GCal-modified instance keeps its own attendees.
 */
export function representativeEventItem(routine: StoredRoutine, occurrence: StoredItem | undefined): StoredItem | undefined {
    if (!occurrence) {
        return undefined;
    }
    return {
        ...occurrence,
        ...((occurrence.organizer ?? routine.organizer) ? { organizer: occurrence.organizer ?? routine.organizer } : {}),
        ...((occurrence.creator ?? routine.creator) ? { creator: occurrence.creator ?? routine.creator } : {}),
        ...((occurrence.attendees ?? routine.attendees) ? { attendees: occurrence.attendees ?? routine.attendees } : {}),
        ...((occurrence.responseStatus ?? routine.responseStatus) ? { responseStatus: occurrence.responseStatus ?? routine.responseStatus } : {}),
        ...((occurrence.htmlLink ?? routine.htmlLink) ? { htmlLink: occurrence.htmlLink ?? routine.htmlLink } : {}),
        ...((occurrence.location ?? routine.location) ? { location: occurrence.location ?? routine.location } : {}),
        ...((occurrence.meetingLink ?? routine.meetingLink) ? { meetingLink: occurrence.meetingLink ?? routine.meetingLink } : {}),
        ...((occurrence.calendarSyncConfigId ?? routine.calendarSyncConfigId)
            ? { calendarSyncConfigId: occurrence.calendarSyncConfigId ?? routine.calendarSyncConfigId }
            : {}),
    };
}
