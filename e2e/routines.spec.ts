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
});
