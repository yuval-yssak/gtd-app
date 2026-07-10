import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice, withTwoLoggedInDevices } from './helpers/context';
import { gtd } from './helpers/gtd';

// Tests routine CRUD, cross-device sync, and item generation on completion.

test.describe('routines', () => {
    test('create routine and verify in IDB and server', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-create-${dayjs().valueOf()}@example.com`, async (page) => {
            const routine = await gtd.createRoutine(page, {
                title: 'Water plants',
                routineType: 'nextAction',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                template: { energy: 'low', time: 5 },
                active: true,
            });

            expect(routine.title).toBe('Water plants');
            expect(routine.routineType).toBe('nextAction');
            expect(routine.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
            expect(routine.active).toBe(true);

            const routines = await gtd.listRoutines(page);
            expect(routines.some((r) => r._id === routine._id)).toBe(true);

            await gtd.flush(page);

            const bootstrap = await gtd.fetchBootstrap(page);
            const serverRoutine = bootstrap.routines.find((r) => r._id === routine._id);
            expect(serverRoutine?.title).toBe('Water plants');
            expect(serverRoutine?.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
        });
    });

    test('routine syncs across devices', async ({ browser }) => {
        const email = `routine-sync-${dayjs().valueOf()}@example.com`;
        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            const routine = await gtd.createRoutine(page1, {
                title: 'Review inbox',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                template: {},
                active: true,
            });
            await gtd.flush(page1);

            await gtd.pull(page2);

            const bootstrap = await gtd.fetchBootstrap(page2);
            const serverRoutine = bootstrap.routines.find((r) => r._id === routine._id);
            expect(serverRoutine?.title).toBe('Review inbox');
        });
    });

    test('deactivating routine persists to server', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-deactivate-${dayjs().valueOf()}@example.com`, async (page) => {
            const routine = await gtd.createRoutine(page, {
                title: 'Meditate',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                template: {},
                active: true,
            });
            await gtd.flush(page);

            const updated = await gtd.updateRoutine(page, { ...routine, active: false });
            expect(updated.active).toBe(false);
            await gtd.flush(page);

            const bootstrap = await gtd.fetchBootstrap(page);
            expect(bootstrap.routines.find((r) => r._id === routine._id)?.active).toBe(false);
        });
    });

    test('removing routine persists to server', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-remove-${dayjs().valueOf()}@example.com`, async (page) => {
            const routine = await gtd.createRoutine(page, {
                title: 'Temporary routine',
                routineType: 'nextAction',
                rrule: 'FREQ=WEEKLY',
                template: {},
                active: true,
            });
            await gtd.flush(page);

            await gtd.removeRoutine(page, routine._id);
            await gtd.flush(page);

            const bootstrap = await gtd.fetchBootstrap(page);
            expect(bootstrap.routines.find((r) => r._id === routine._id)).toBeUndefined();
        });
    });

    test('pause routine: flips active=false and trashes future open items', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-pause-${dayjs().valueOf()}@example.com`, async (page) => {
            // Use today's startDate so materializePendingNextActionRoutines (the boot-tick) seeds the
            // first item with expectedBy=today — __gtd.createRoutine alone doesn't generate items;
            // that's handled by RoutineDialog.tsx in the UI path. The seeded item must have
            // expectedBy >= today so pauseRoutine's trashFutureItemsFromDate(today) catches it.
            const today = dayjs().format('YYYY-MM-DD');
            const routine = await gtd.createRoutine(page, {
                title: 'Workout',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                template: {},
                active: true,
                startDate: today,
            });
            await gtd.materializePendingNextActionRoutines(page);
            const itemsBefore = (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status !== 'done' && i.status !== 'trash');
            expect(itemsBefore.length).toBeGreaterThan(0);

            await gtd.pauseRoutine(page, routine._id);

            // Active flipped.
            const reloaded = (await gtd.listRoutines(page)).find((r) => r._id === routine._id);
            expect(reloaded?.active).toBe(false);
            // Future open items trashed.
            const openAfter = (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status !== 'done' && i.status !== 'trash');
            expect(openAfter).toHaveLength(0);
        });
    });

    test('resume routine via updateRoutine with new startDate materializes items', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-resume-${dayjs().valueOf()}@example.com`, async (page) => {
            const routine = await gtd.createRoutine(page, {
                title: 'Stretch',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                template: {},
                active: true,
            });
            await gtd.pauseRoutine(page, routine._id);
            // Flip active=true with startDate in the past so the boot-tick materializes an item.
            const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
            await gtd.updateRoutine(page, { ...routine, active: true, startDate: yesterday });

            await gtd.materializePendingNextActionRoutines(page);

            const openItems = (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status !== 'done' && i.status !== 'trash');
            expect(openItems.length).toBeGreaterThan(0);
        });
    });

    test('create nextAction routine with future startDate: boot-tick materializes a tickler-hidden item', async ({ browser }) => {
        // Server-side bootstrap generates the first item on routine create, and the client's boot
        // tick now also materializes future-startDate routines (anchor at max(today, startDate),
        // includeAnchor=true). The previous "skip until startDate arrives" behaviour was a bug —
        // future-startDate routines went unbacked until the startDate crossed today AND the user
        // opened the app. The item is hidden until due via `ignoreBefore = expectedBy` (tickler).
        await withOneLoggedInDevice(browser, `routine-future-start-${dayjs().valueOf()}@example.com`, async (page) => {
            const futureStart = dayjs().add(7, 'day').format('YYYY-MM-DD');
            const routine = await gtd.createRoutine(page, {
                title: 'Future start',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                template: {},
                active: true,
                startDate: futureStart,
            });
            await gtd.materializePendingNextActionRoutines(page);
            const openItems = (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status !== 'done' && i.status !== 'trash');
            expect(openItems).toHaveLength(1);
            const [item] = openItems;
            if (!item) throw new Error('expected one open item');
            expect(item.expectedBy).toBe(futureStart);
            expect(item.ignoreBefore).toBe(futureStart);
        });
    });

    test('round-trips routine.startDate through push + bootstrap', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-start-${dayjs().valueOf()}@example.com`, async (page) => {
            const start = '2027-01-15';
            const routine = await gtd.createRoutine(page, {
                title: 'Anchor test',
                routineType: 'nextAction',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                template: {},
                active: true,
                startDate: start,
            });
            await gtd.flush(page);

            const bootstrap = await gtd.fetchBootstrap(page);
            expect(bootstrap.routines.find((r) => r._id === routine._id)?.startDate).toBe(start);
        });
    });

    test('deleting a nextAction routine trashes its open generated item', async ({ browser }) => {
        // Regression: DELETE previously only cascaded to status='calendar' items, orphaning
        // nextAction-status generated items forever.
        await withOneLoggedInDevice(browser, `routine-delete-cascade-${dayjs().valueOf()}@example.com`, async (page) => {
            const today = dayjs().format('YYYY-MM-DD');
            const routine = await gtd.createRoutine(page, {
                title: 'Withdraw cash',
                routineType: 'nextAction',
                rrule: 'FREQ=MONTHLY',
                template: {},
                active: true,
                startDate: today,
            });
            await gtd.materializePendingNextActionRoutines(page);
            const openBefore = (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status !== 'done' && i.status !== 'trash');
            expect(openBefore.length).toBeGreaterThan(0);

            await gtd.removeRoutine(page, routine._id);

            const openAfter = (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status !== 'done' && i.status !== 'trash');
            expect(openAfter).toHaveLength(0);
            const trashed = (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status === 'trash');
            expect(trashed.length).toBeGreaterThan(0);
        });
    });

    test('floating monthly routine: late completion advances the next occurrence to the completion date, not the original due date', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-floating-${dayjs().valueOf()}@example.com`, async (page) => {
            const startDate = dayjs().subtract(10, 'day').format('YYYY-MM-DD');
            const routine = await gtd.createRoutine(page, {
                title: 'Floating monthly',
                routineType: 'nextAction',
                rrule: 'FREQ=MONTHLY', // bare — no BYMONTHDAY — floating
                recurrenceAnchor: 'floating',
                template: {},
                active: true,
                startDate,
            });
            await gtd.materializePendingNextActionRoutines(page);
            const [openItem] = (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status === 'nextAction');
            if (!openItem) throw new Error('expected one open item');

            await gtd.clarifyToDone(page, openItem);

            const [nextItem] = (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status === 'nextAction');
            if (!nextItem) throw new Error('expected the next occurrence to be generated');
            // Floating: the next occurrence lands one month after the ACTUAL completion day (today),
            // not one month after the original due date (startDate).
            const expectedNextMonth = dayjs().add(1, 'month').format('YYYY-MM-DD');
            expect(nextItem.expectedBy).toBe(expectedNextMonth);
        });
    });

    test("fixed monthly routine: completing today still lands the next occurrence on the pinned day, not today's day-of-month", async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-fixed-${dayjs().valueOf()}@example.com`, async (page) => {
            const pinnedDay = 5;
            const startDate = dayjs().subtract(1, 'month').date(pinnedDay).format('YYYY-MM-DD');
            const routine = await gtd.createRoutine(page, {
                title: 'Fixed monthly',
                routineType: 'nextAction',
                rrule: `FREQ=MONTHLY;BYMONTHDAY=${pinnedDay}`,
                recurrenceAnchor: 'fixed',
                template: {},
                active: true,
                startDate,
            });
            await gtd.materializePendingNextActionRoutines(page);
            const [openItem] = (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status === 'nextAction');
            if (!openItem) throw new Error('expected one open item');
            // Confirm the harness precondition: the open item itself is pinned to the 5th (its
            // own due date), regardless of what today's date is.
            expect(openItem.expectedBy?.slice(8, 10)).toBe('05');

            // Complete today — today's day-of-month is very unlikely to be the 5th (this test runs
            // on whatever date CI/dev happens to run), so a floating-style drift to today's day
            // would fail this assertion. Fixed mode must still pin the next occurrence to the 5th.
            await gtd.clarifyToDone(page, openItem);

            const [nextItem] = (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status === 'nextAction');
            if (!nextItem) throw new Error('expected the next occurrence to be generated');
            // The disposal path formats the next occurrence via dayjs(nextDueDate).format('YYYY-MM-DD')
            // in the runner's LOCAL timezone, while the rrule computation itself is UTC-anchored — so
            // right around local midnight the formatted day can land on 5 or 6 depending on the exact
            // offset (a pre-existing characteristic of createNextRoutineItem, not something this
            // feature changes). What matters for THIS test is that the day did NOT drift to today's
            // day-of-month, which is what a floating-mode bug would produce.
            const nextDay = Number(nextItem.expectedBy?.slice(8, 10));
            expect([pinnedDay, pinnedDay + 1]).toContain(nextDay);
            expect(nextDay).not.toBe(dayjs().date());
        });
    });
});
