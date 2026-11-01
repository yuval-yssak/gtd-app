import { describe, expect, it } from 'vitest';
import { type PriorityItem, priorityComparator, type UserClock } from '../lib/itemPriorityOrder.js';

const T0 = '2026-01-01T00:00:00.000Z';
const UTC_CLOCK: UserClock = { timeZone: 'UTC', today: '2026-11-01' };

function item(id: string, fields: Partial<PriorityItem> & Pick<PriorityItem, 'status'>): PriorityItem {
    return { _id: id, user: 'u', title: id, createdTs: T0, updatedTs: T0, ...fields };
}

function sortedIds(items: readonly PriorityItem[], clock: UserClock = UTC_CLOCK): string[] {
    return [...items].sort(priorityComparator(clock)).map((row) => row._id);
}

describe('priorityComparator — lists', () => {
    it('follows the app navigation: inbox, next actions, calendar, waiting for, tickler, someday, then done and trash', () => {
        const items = [
            item('trash', { status: 'trash' }),
            item('done', { status: 'done' }),
            item('someday', { status: 'somedayMaybe', rank: 'a0' }),
            item('snoozed', { status: 'nextAction', rank: 'a0', ignoreBefore: '2026-12-01' }),
            item('waiting', { status: 'waitingFor', rank: 'a0' }),
            item('calendar', { status: 'calendar', timeStart: '2026-11-02T10:00:00' }),
            item('next', { status: 'nextAction', rank: 'a0' }),
            item('inbox', { status: 'inbox', rank: 'a0' }),
        ];
        expect(sortedIds(items)).toEqual(['inbox', 'next', 'calendar', 'waiting', 'snoozed', 'someday', 'done', 'trash']);
    });
});

describe('priorityComparator — tickler', () => {
    it('moves snoozed next actions, waiting fors and somedays out of their lists into the tickler, earliest wake-up first', () => {
        const items = [
            item('next-early-due', { status: 'nextAction', rank: 'a0', expectedBy: '2026-11-02', ignoreBefore: '2026-11-20' }),
            item('someday-snoozed', { status: 'somedayMaybe', rank: 'a0', ignoreBefore: '2026-11-10' }),
            item('waiting-snoozed', { status: 'waitingFor', rank: 'a0', ignoreBefore: '2026-11-15' }),
            item('next-active', { status: 'nextAction', rank: 'a5', expectedBy: '2026-11-30' }),
        ];
        expect(sortedIds(items)).toEqual(['next-active', 'someday-snoozed', 'waiting-snoozed', 'next-early-due']);
    });

    it('keeps an item whose ignoreBefore is today or past in its own list', () => {
        const items = [
            item('wakes-today', { status: 'nextAction', rank: 'a1', ignoreBefore: '2026-11-01' }),
            item('woke-earlier', { status: 'nextAction', rank: 'a0', ignoreBefore: '2026-10-01' }),
            item('waiting', { status: 'waitingFor', rank: 'a0' }),
        ];
        expect(sortedIds(items)).toEqual(['woke-earlier', 'wakes-today', 'waiting']);
    });

    it('never snoozes inbox or calendar items (ignoreBefore does not apply to them)', () => {
        const items = [
            item('calendar', { status: 'calendar', timeStart: '2026-11-02T10:00:00', ignoreBefore: '2026-12-01' }),
            item('inbox', { status: 'inbox', ignoreBefore: '2026-12-01' }),
        ];
        expect(sortedIds(items)).toEqual(['inbox', 'calendar']);
    });
});

describe('priorityComparator — next actions and waiting for', () => {
    it('orders next actions by expected day (undated last), then by rank inside a day', () => {
        const items = [
            item('undated-top', { status: 'nextAction', rank: 'a0' }),
            item('later-day', { status: 'nextAction', rank: 'a0', expectedBy: '2026-11-05' }),
            item('day-second', { status: 'nextAction', rank: 'a2', expectedBy: '2026-11-03' }),
            item('day-first', { status: 'nextAction', rank: 'a1', expectedBy: '2026-11-03' }),
        ];
        expect(sortedIds(items)).toEqual(['day-first', 'day-second', 'later-day', 'undated-top']);
    });

    it('orders waiting-for items with undated FIRST, like the app (an open-ended obligation deserves a look before dated ones)', () => {
        const items = [
            item('dated', { status: 'waitingFor', rank: 'a0', expectedBy: '2026-11-03' }),
            item('undated', { status: 'waitingFor', rank: 'a0' }),
            item('later', { status: 'waitingFor', rank: 'a0', expectedBy: '2026-11-09' }),
        ];
        expect(sortedIds(items)).toEqual(['undated', 'dated', 'later']);
    });

    it("groups a datetime expectedBy by the user's local day", () => {
        // 03:00Z on the 4th is the evening of the 3rd in New York: same day as the date-only row, and ranked above it.
        const items = [
            item('date-only', { status: 'nextAction', rank: 'a5', expectedBy: '2026-11-03' }),
            item('evening', { status: 'nextAction', rank: 'a1', expectedBy: '2026-11-04T03:00:00.000Z' }),
        ];
        expect(sortedIds(items, { timeZone: 'America/New_York', today: '2026-11-01' })).toEqual(['evening', 'date-only']);
        expect(sortedIds(items)).toEqual(['date-only', 'evening']);
    });

    it('puts unranked rows of a list first, newest first, like the app', () => {
        const items = [
            item('ranked', { status: 'inbox', rank: 'a0' }),
            item('old-unranked', { status: 'inbox', createdTs: '2026-01-01T00:00:00.000Z' }),
            item('new-unranked', { status: 'inbox', createdTs: '2026-02-01T00:00:00.000Z' }),
        ];
        expect(sortedIds(items)).toEqual(['new-unranked', 'old-unranked', 'ranked']);
    });
});

describe('priorityComparator — calendar', () => {
    const JERUSALEM: UserClock = { timeZone: 'Asia/Jerusalem', today: '2026-11-01' };

    it('orders by local day, all-day events first (by title), then timed events by instant — mixing Z and floating times', () => {
        const items = [
            // 23:30Z on the 2nd is 01:30 on the 3rd in Jerusalem.
            item('gcal-after-midnight', { status: 'calendar', timeStart: '2026-11-02T23:30:00Z' }),
            // Floating 00:30 on the 3rd is wall time in Jerusalem — earlier than 01:30.
            item('floating-0030', { status: 'calendar', timeStart: '2026-11-03T00:30:00' }),
            item('zz-all-day', { status: 'calendar', allDay: true, timeStart: '2026-11-03', title: 'Zebra day' }),
            item('aa-all-day', { status: 'calendar', allDay: true, timeStart: '2026-11-03', title: 'Anniversary' }),
            item('day-before', { status: 'calendar', timeStart: '2026-11-02T09:00:00' }),
        ];
        expect(sortedIds(items, JERUSALEM)).toEqual(['day-before', 'aa-all-day', 'zz-all-day', 'floating-0030', 'gcal-after-midnight']);
    });

    it('puts calendar items without a start last, by title like the page', () => {
        const items = [
            item('a-id', { status: 'calendar', title: 'Zoo trip' }),
            item('b-id', { status: 'calendar', title: 'Appointment' }),
            item('early', { status: 'calendar', timeStart: '2026-11-02T09:00:00' }),
        ];
        expect(sortedIds(items)).toEqual(['early', 'b-id', 'a-id']);
    });

    it('is total: equal keys fall back to _id', () => {
        const items = [
            item('b', { status: 'calendar', timeStart: '2026-11-02T09:00:00' }),
            item('a', { status: 'calendar', timeStart: '2026-11-02T09:00:00' }),
        ];
        expect(sortedIds(items)).toEqual(['a', 'b']);
    });
});

describe('priorityComparator — done and trash', () => {
    it('orders them most recently updated first', () => {
        const items = [
            item('done-old', { status: 'done', updatedTs: '2026-01-01T00:00:00.000Z' }),
            item('done-new', { status: 'done', updatedTs: '2026-03-01T00:00:00.000Z' }),
        ];
        expect(sortedIds(items)).toEqual(['done-new', 'done-old']);
    });
});
