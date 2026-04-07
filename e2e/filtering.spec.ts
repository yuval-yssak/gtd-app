import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Tests query helpers that filter items by GTD metadata:
// energy, time, work context, and the tickler (ignoreBefore) pattern.

test.describe('filtering', () => {
    test('listNextActions filters by energy', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `filter-energy-${dayjs().valueOf()}@example.com`, async (page) => {
            const a = await gtd.collect(page, 'Low energy task');
            const b = await gtd.collect(page, 'High energy task');
            await gtd.clarifyToNextAction(page, a, { energy: 'low' });
            await gtd.clarifyToNextAction(page, b, { energy: 'high' });

            const lowOnly = await gtd.listNextActions(page, { energy: 'low' });
            expect(lowOnly.every((i) => i.energy === 'low')).toBe(true);
            expect(lowOnly.some((i) => i._id === a._id)).toBe(true);
            expect(lowOnly.some((i) => i._id === b._id)).toBe(false);
        });
    });

    test('listNextActions filters by work context', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `filter-ctx-${dayjs().valueOf()}@example.com`, async (page) => {
            const ctx = await gtd.createWorkContext(page, 'At home');
            const a = await gtd.collect(page, 'Home task');
            const b = await gtd.collect(page, 'Anywhere task');
            await gtd.clarifyToNextAction(page, a, { workContextIds: [ctx._id] });
            await gtd.clarifyToNextAction(page, b);

            const filtered = await gtd.listNextActions(page, { workContextId: ctx._id });
            expect(filtered.some((i) => i._id === a._id)).toBe(true);
            expect(filtered.some((i) => i._id === b._id)).toBe(false);
        });
    });

    test('listNextActions filters by max time', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `filter-time-${dayjs().valueOf()}@example.com`, async (page) => {
            const quick = await gtd.collect(page, 'Quick task');
            const long = await gtd.collect(page, 'Long task');
            await gtd.clarifyToNextAction(page, quick, { time: 5 });
            await gtd.clarifyToNextAction(page, long, { time: 60 });

            const shortTasks = await gtd.listNextActions(page, { maxMinutes: 30 });
            expect(shortTasks.some((i) => i._id === quick._id)).toBe(true);
            expect(shortTasks.some((i) => i._id === long._id)).toBe(false);
        });
    });

    test('tickler items hidden before ignoreBefore date', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `tickler-${dayjs().valueOf()}@example.com`, async (page) => {
            const futureItem = await gtd.collect(page, 'Future task');
            const todayItem = await gtd.collect(page, 'Today task');

            const futureDate = dayjs().add(30, 'day').format('YYYY-MM-DD');
            await gtd.clarifyToNextAction(page, futureItem, { ignoreBefore: futureDate });
            await gtd.clarifyToNextAction(page, todayItem);

            const activeItems = await gtd.listNextActions(page);
            // Future task should be hidden (ignoreBefore is in the future)
            expect(activeItems.some((i) => i._id === futureItem._id)).toBe(false);
            // Today task should be visible
            expect(activeItems.some((i) => i._id === todayItem._id)).toBe(true);
        });
    });

    test('listCalendar returns calendar items sorted by timeStart', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `cal-list-${dayjs().valueOf()}@example.com`, async (page) => {
            const a = await gtd.collect(page, 'Later meeting');
            const b = await gtd.collect(page, 'Earlier meeting');

            const laterStart = dayjs().add(3, 'day').hour(14).toISOString();
            const laterEnd = dayjs().add(3, 'day').hour(15).toISOString();
            const earlierStart = dayjs().add(1, 'day').hour(10).toISOString();
            const earlierEnd = dayjs().add(1, 'day').hour(11).toISOString();

            await gtd.clarifyToCalendar(page, a, { timeStart: laterStart, timeEnd: laterEnd });
            await gtd.clarifyToCalendar(page, b, { timeStart: earlierStart, timeEnd: earlierEnd });

            const calItems = await gtd.listCalendar(page);
            expect(calItems.length).toBeGreaterThanOrEqual(2);

            const idxA = calItems.findIndex((i) => i._id === a._id);
            const idxB = calItems.findIndex((i) => i._id === b._id);
            // Earlier meeting should come before later meeting
            expect(idxB).toBeLessThan(idxA);
        });
    });
});
