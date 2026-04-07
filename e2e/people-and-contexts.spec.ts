import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice, withTwoLoggedInDevices } from './helpers/context';
import { gtd } from './helpers/gtd';

// Tests CRUD operations for people and work contexts,
// and verifies they sync correctly across devices.

test.describe('people and work contexts', () => {
    test('create person and use in waiting-for item', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `person-wf-${dayjs().valueOf()}@example.com`, async (page) => {
            const person = await gtd.createPerson(page, { name: 'Carol', email: 'carol@example.com', phone: '555-1234' });
            expect(person.name).toBe('Carol');
            expect(person.email).toBe('carol@example.com');

            const inbox = await gtd.collect(page, 'Ask Carol');
            const wf = await gtd.clarifyToWaitingFor(page, inbox, { waitingForPersonId: person._id });

            await gtd.flush(page);

            const bootstrap = await gtd.fetchBootstrap(page);
            expect(bootstrap.people.find((p) => p._id === person._id)?.name).toBe('Carol');
            expect(bootstrap.items.find((i) => i._id === wf._id)?.waitingForPersonId).toBe(person._id);
        });
    });

    test('create work context and assign to next-action', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `ctx-na-${dayjs().valueOf()}@example.com`, async (page) => {
            const ctx = await gtd.createWorkContext(page, 'At the office');
            expect(ctx.name).toBe('At the office');

            const inbox = await gtd.collect(page, 'Print report');
            const na = await gtd.clarifyToNextAction(page, inbox, { workContextIds: [ctx._id] });

            await gtd.flush(page);

            const bootstrap = await gtd.fetchBootstrap(page);
            expect(bootstrap.workContexts.find((w) => w._id === ctx._id)?.name).toBe('At the office');
            const serverItem = bootstrap.items.find((i) => i._id === na._id);
            expect(serverItem?.workContextIds).toContain(ctx._id);
        });
    });

    test('person syncs across devices', async ({ browser }) => {
        const email = `person-sync-${dayjs().valueOf()}@example.com`;
        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            const person = await gtd.createPerson(page1, { name: 'Dave' });
            await gtd.flush(page1);

            await gtd.pull(page2);

            // Verify person appeared in device-2's bootstrap (server-side check)
            const bootstrap = await gtd.fetchBootstrap(page2);
            expect(bootstrap.people.find((p) => p._id === person._id)?.name).toBe('Dave');
        });
    });

    test('work context syncs across devices', async ({ browser }) => {
        const email = `ctx-sync-${dayjs().valueOf()}@example.com`;
        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            const ctx = await gtd.createWorkContext(page1, 'Errands');
            await gtd.flush(page1);

            await gtd.pull(page2);

            const bootstrap = await gtd.fetchBootstrap(page2);
            expect(bootstrap.workContexts.find((w) => w._id === ctx._id)?.name).toBe('Errands');
        });
    });
});
