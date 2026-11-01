import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import type { ItemInterface } from '../types/entities.js';
import { toInstant } from './isoInstant.js';
import { compareByRank, expectedDayKey } from './itemMove.js';
import { compareRank } from './itemRank.js';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * "Priority order" for `GET /v1/items?sort=priority` (the MCP `gtd_list_items` default): items in
 * the app's navigation order — Inbox, Next Actions, Calendar, Waiting For, Tickler, Someday / Maybe
 * (`client/src/components/AppNav.tsx`), then Done and Trash — each list in its own page's order:
 *  - Inbox, Someday / Maybe: the manual rank (`compareByRank`, what `POST /v1/items/:id/move` writes);
 *  - Next Actions: expected day (undated last), rank inside the day (client `compareNextActions`);
 *  - Waiting For: its "By date" view — expected day with undated FIRST, then rank
 *    (client `compareWaitingForByExpectedBy`);
 *  - Calendar: the page's day grouping (client `compareCalendarItems`);
 *  - Tickler: snoozed Next Actions / Waiting For / Someday rows (`ignoreBefore` after today), which
 *    their own pages hide, earliest wake-up first (client `tickler.tsx`);
 *  - Done, Trash: most recently updated first.
 * Total: `_id` breaks every remaining tie.
 */

/** A row as the order sees it — `_id` narrowed once, before sorting, rather than on every comparison. */
export type PriorityItem = ItemInterface & { _id: string };

/** What the order needs to know about the user's day: their timezone and their local "today" (YYYY-MM-DD). */
export interface UserClock {
    timeZone: string;
    today: string;
}

type Tier = ItemInterface['status'] | 'tickler';
type ItemComparator = (a: PriorityItem, b: PriorityItem) => number;

const TIER_ORDER: ReadonlyArray<Tier> = ['inbox', 'nextAction', 'calendar', 'waitingFor', 'tickler', 'somedayMaybe', 'done', 'trash'];
// Mirrors client `TICKLER_STATUSES` — calendar and inbox rows ignore `ignoreBefore`.
const TICKLER_STATUSES: ReadonlySet<ItemInterface['status']> = new Set(['nextAction', 'waitingFor', 'somedayMaybe']);

// Sort keys standing in for "no value": below / above every `YYYY-MM-DD` by code unit.
const BEFORE_ANY = '';
const AFTER_ANY = '￿';

function tierOf(item: PriorityItem, today: string): Tier {
    const isSnoozed = TICKLER_STATUSES.has(item.status) && item.ignoreBefore !== undefined && item.ignoreBefore > today;
    return isSnoozed ? 'tickler' : item.status;
}

const byId: ItemComparator = (a, b) => compareRank(a._id, b._id);

/**
 * Expected day ascending, then rank inside the day. Undated rows go LAST in Next Actions (the
 * lowest tier) but FIRST in Waiting For (an open-ended obligation owed to you deserves a look first).
 */
function byDayThenRank(timeZone: string, undated: 'first' | 'last'): ItemComparator {
    const dayOf = (item: PriorityItem) => expectedDayKey(item.expectedBy, timeZone) ?? (undated === 'first' ? BEFORE_ANY : AFTER_ANY);
    return (a, b) => compareRank(dayOf(a), dayOf(b)) || compareByRank(a, b);
}

/** The day a calendar row is listed under: an all-day start verbatim, a timed start's local day (a floating one is wall time there). */
function calendarDayOf(item: PriorityItem, timeZone: string): string {
    if (!item.timeStart) {
        return AFTER_ANY;
    }
    return item.allDay ? item.timeStart.slice(0, 10) : dayjs(toInstant(item.timeStart, timeZone)).tz(timeZone).format('YYYY-MM-DD');
}

function isTitleOrdered(a: PriorityItem, b: PriorityItem): boolean {
    return (a.allDay === true && b.allDay === true) || (!a.timeStart && !b.timeStart);
}

/**
 * The Calendar page order: by day, all-day events first (by title), then timed events by INSTANT —
 * GCal rows carry `Z`/offsets and in-app rows are floating, so their strings do not compare.
 */
function byCalendarSlot(timeZone: string): ItemComparator {
    const instantOf = (item: PriorityItem) => (item.timeStart && !item.allDay ? toInstant(item.timeStart, timeZone) : 0);
    return (a, b) =>
        compareRank(calendarDayOf(a, timeZone), calendarDayOf(b, timeZone)) ||
        Number(b.allDay === true) - Number(a.allDay === true) ||
        // Two all-day events, or two with no start at all (the page's "No date" bucket), order by title.
        (isTitleOrdered(a, b) ? a.title.localeCompare(b.title) : instantOf(a) - instantOf(b)) ||
        byId(a, b);
}

const byWakeUp: ItemComparator = (a, b) => compareRank(a.ignoreBefore ?? AFTER_ANY, b.ignoreBefore ?? AFTER_ANY) || byId(a, b);

const byNewestUpdate: ItemComparator = (a, b) => compareRank(b.updatedTs, a.updatedTs) || byId(a, b);

/** How rows of one tier are ordered among themselves. */
function withinTier(timeZone: string): Record<Tier, ItemComparator> {
    return {
        inbox: compareByRank,
        nextAction: byDayThenRank(timeZone, 'last'),
        calendar: byCalendarSlot(timeZone),
        waitingFor: byDayThenRank(timeZone, 'first'),
        tickler: byWakeUp,
        somedayMaybe: compareByRank,
        done: byNewestUpdate,
        trash: byNewestUpdate,
    };
}

/** The priority-order comparator for a user at `clock`. */
export function priorityComparator(clock: UserClock): ItemComparator {
    const within = withinTier(clock.timeZone);
    return (a, b) => {
        const tierA = tierOf(a, clock.today);
        const tierB = tierOf(b, clock.today);
        return TIER_ORDER.indexOf(tierA) - TIER_ORDER.indexOf(tierB) || within[tierA](a, b);
    };
}
