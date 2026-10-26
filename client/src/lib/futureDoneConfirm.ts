import dayjs from 'dayjs';
import type { StoredItem } from '../types/MyDB';

/**
 * True when a calendar item starts on a later calendar day than today, in the device's time zone —
 * marking it done is then probably a slip, so the UI asks first. An event later today is not
 * future: finishing it early is normal. An all-day `YYYY-MM-DD` start parses as local midnight of
 * that date, a timed ISO start converts to its local date, so one day comparison covers both.
 */
export function startsOnFutureDay(item: StoredItem, now = dayjs()) {
    return item.status === 'calendar' && item.timeStart !== undefined && dayjs(item.timeStart).isAfter(now, 'day');
}

/** "Tue, Oct 27 at 9:30 am", or just the day for an all-day event. */
export function describeEventStart(item: StoredItem) {
    const start = dayjs(item.timeStart);
    return item.allDay ? start.format('ddd, MMM D') : start.format('ddd, MMM D [at] h:mm a');
}
