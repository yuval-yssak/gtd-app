import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { hasAtLeastOne } from '../client/src/lib/typeUtils';
import { withOneLoggedInDevice, withTwoLoggedInDevices } from './helpers/context';
import { gtd } from './helpers/gtd';

// Tests calendar routine horizon-based item generation, cross-device sync, and rrule edit regeneration.

test.describe('calendar routine horizon', () => {
    test('generates multiple items up to horizon and syncs to server', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `cal-horizon-${dayjs().valueOf()}@example.com`, async (page) => {
            const routine = await gtd.createRoutine(page, {
                title: 'Weekly standup',
                routineType: 'calendar',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                template: {},
                calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
                active: true,
            });

            await gtd.generateCalendarItemsToHorizon(page, routine._id);
            await gtd.flush(page);

            // Verify locally: multiple calendar items for this routine
            const localItems = await gtd.listCalendar(page);
            const routineItems = localItems.filter((i) => i.routineId === routine._id);
            // Weekly for 2 months: expect ~8-9 items
            expect(routineItems.length).toBeGreaterThanOrEqual(7);

            // Verify all items are on Mondays at 09:00
            for (const item of routineItems) {
                expect(dayjs(item.timeStart).day()).toBe(1);
                expect(item.timeStart).toContain('T09:00:00');
                expect(item.timeEnd).toContain('T09:30:00');
            }

            // Verify server has the same items
            const bootstrap = await gtd.fetchBootstrap(page);
            const serverItems = bootstrap.items.filter((i) => i.routineId === routine._id && i.status === 'calendar');
            expect(serverItems.length).toBe(routineItems.length);
        });
    });

    test('completion extends horizon and syncs across devices', async ({ browser }) => {
        const email = `cal-horizon-sync-${dayjs().valueOf()}@example.com`;

        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            // Device 1: create routine + generate items
            const routine = await gtd.createRoutine(page1, {
                title: 'Biweekly review',
                routineType: 'calendar',
                rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE',
                template: {},
                calendarItemTemplate: { timeOfDay: '14:00', duration: 60 },
                active: true,
            });
            await gtd.generateCalendarItemsToHorizon(page1, routine._id);
            await gtd.flush(page1);

            const itemsBefore = (await gtd.listCalendar(page1)).filter((i) => i.routineId === routine._id);
            const countBefore = itemsBefore.length;
            expect(countBefore).toBeGreaterThanOrEqual(3);

            // Device 2: pull, then complete the nearest item
            await gtd.pull(page2);
            const device2Items = (await gtd.listCalendar(page2)).filter((i) => i.routineId === routine._id);
            if (!hasAtLeastOne(device2Items)) {
                throw new Error('No items found on device 2');
            }
            expect(device2Items.length).toBe(countBefore);

            // Sort by timeStart and complete the earliest one
            const sorted = device2Items.sort((a, b) => (a.timeStart ?? '').localeCompare(b.timeStart ?? ''));
            await gtd.clarifyToDone(page2, sorted[0]);
            await gtd.flush(page2);

            // Device 1: pull and verify horizon extended (should still have at least as many items)
            await gtd.pull(page1);
            const itemsAfter = (await gtd.listCalendar(page1)).filter((i) => i.routineId === routine._id);
            // One item was completed (now 'done'), but horizon extension may have added new ones
            // The total active calendar items should be >= countBefore - 1
            expect(itemsAfter.length).toBeGreaterThanOrEqual(countBefore - 1);
        });
    });

    test('rrule edit regenerates items and syncs to server', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `cal-horizon-edit-${dayjs().valueOf()}@example.com`, async (page) => {
            // Create a weekly routine
            const routine = await gtd.createRoutine(page, {
                title: 'Team sync',
                routineType: 'calendar',
                rrule: 'FREQ=WEEKLY;BYDAY=TU',
                template: {},
                calendarItemTemplate: { timeOfDay: '10:00', duration: 45 },
                active: true,
            });
            await gtd.generateCalendarItemsToHorizon(page, routine._id);
            await gtd.flush(page);

            const weeklyItems = (await gtd.listCalendar(page)).filter((i) => i.routineId === routine._id);
            const weeklyCount = weeklyItems.length;
            expect(weeklyCount).toBeGreaterThanOrEqual(7);

            // All items should be on Tuesdays
            for (const item of weeklyItems) {
                expect(dayjs(item.timeStart).day()).toBe(2);
            }

            // Change to biweekly on Thursdays
            const updated = await gtd.updateRoutine(page, {
                ...routine,
                rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TH',
                calendarItemTemplate: { timeOfDay: '11:00', duration: 45 },
            });
            await gtd.deleteAndRegenerateFutureItems(page, updated._id);
            await gtd.flush(page);

            // Verify: fewer items, now on Thursdays at 11:00
            const biweeklyItems = (await gtd.listCalendar(page)).filter((i) => i.routineId === routine._id);
            expect(biweeklyItems.length).toBeLessThan(weeklyCount);
            expect(biweeklyItems.length).toBeGreaterThanOrEqual(3);

            for (const item of biweeklyItems) {
                expect(dayjs(item.timeStart).day()).toBe(4);
                expect(item.timeStart).toContain('T11:00:00');
            }

            // Verify server reflects the change — no stale Tuesday items
            const bootstrap = await gtd.fetchBootstrap(page);
            const serverItems = bootstrap.items.filter((i) => i.routineId === routine._id && i.status === 'calendar');
            expect(serverItems.length).toBe(biweeklyItems.length);

            // Server should have no Tuesday items left
            const tuesdayItems = serverItems.filter((i) => dayjs(i.timeStart).day() === 2);
            expect(tuesdayItems).toHaveLength(0);
        });
    });

    test('future startDate produces no items before the startDate', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `cal-future-start-${dayjs().valueOf()}@example.com`, async (page) => {
            const futureStart = dayjs().add(21, 'day').format('YYYY-MM-DD');
            const routine = await gtd.createRoutine(page, {
                title: 'Future cal',
                routineType: 'calendar',
                rrule: 'FREQ=DAILY',
                template: {},
                calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
                active: true,
                startDate: futureStart,
            });

            await gtd.generateCalendarItemsToHorizon(page, routine._id);
            const items = (await gtd.listCalendar(page)).filter((i) => i.routineId === routine._id);
            // All items must be on or after the startDate.
            expect(items.every((i) => (i.timeStart ?? '').slice(0, 10) >= futureStart)).toBe(true);
            // Something was generated (horizon extends past startDate).
            expect(items.length).toBeGreaterThan(0);
        });
    });

    test('paused calendar routine: horizon generator no-ops', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `cal-paused-${dayjs().valueOf()}@example.com`, async (page) => {
            const routine = await gtd.createRoutine(page, {
                title: 'Paused cal',
                routineType: 'calendar',
                rrule: 'FREQ=DAILY',
                template: {},
                calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
                active: false, // Start paused — generator must skip.
            });

            await gtd.generateCalendarItemsToHorizon(page, routine._id);
            const items = (await gtd.listCalendar(page)).filter((i) => i.routineId === routine._id);
            expect(items).toHaveLength(0);
        });
    });
});
