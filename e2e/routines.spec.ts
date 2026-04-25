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
            const routine = await gtd.createRoutine(page, {
                title: 'Workout',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                template: {},
                active: true,
            });
            // The create path auto-generates the first nextAction item.
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

    test('create nextAction routine with future startDate: no item until boot-tick after startDate arrives', async ({ browser }) => {
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
            // materializePending with future startDate should NOT generate anything.
            await gtd.materializePendingNextActionRoutines(page);
            const openItems = (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status !== 'done' && i.status !== 'trash');
            expect(openItems).toHaveLength(0);

            // Simulate startDate arriving by updating the routine's startDate to yesterday.
            const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
            await gtd.updateRoutine(page, { ...routine, startDate: yesterday });
            await gtd.materializePendingNextActionRoutines(page);
            const afterItems = (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status !== 'done' && i.status !== 'trash');
            expect(afterItems.length).toBeGreaterThan(0);
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
});
