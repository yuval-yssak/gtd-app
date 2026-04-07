import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Tests clarify paths not covered by collect-and-clarify.spec.ts:
// calendar, waiting-for, trash, and batch clarification to multiple statuses.

test.describe('clarify to all statuses', () => {
    test('clarify to calendar with time fields', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `cal-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Team standup');
            const timeStart = dayjs().add(1, 'day').hour(9).minute(0).second(0).toISOString();
            const timeEnd = dayjs().add(1, 'day').hour(9).minute(30).second(0).toISOString();

            const calItem = await gtd.clarifyToCalendar(page, inbox, { timeStart, timeEnd });
            expect(calItem.status).toBe('calendar');
            expect(calItem.timeStart).toBe(timeStart);
            expect(calItem.timeEnd).toBe(timeEnd);

            await gtd.flush(page);
            expect(await gtd.queuedOps(page)).toHaveLength(0);

            const bootstrap = await gtd.fetchBootstrap(page);
            const serverItem = bootstrap.items.find((i) => i._id === calItem._id);
            expect(serverItem?.status).toBe('calendar');
            expect(serverItem?.timeStart).toBe(timeStart);
            expect(serverItem?.timeEnd).toBe(timeEnd);
        });
    });

    test('clarify to waiting-for with person and expected-by', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wf-${dayjs().valueOf()}@example.com`, async (page) => {
            const person = await gtd.createPerson(page, { name: 'Alice', email: 'alice@example.com' });
            const inbox = await gtd.collect(page, 'Wait for Alice');
            const expectedBy = dayjs().add(7, 'day').format('YYYY-MM-DD');

            const wfItem = await gtd.clarifyToWaitingFor(page, inbox, {
                waitingForPersonId: person._id,
                expectedBy,
            });
            expect(wfItem.status).toBe('waitingFor');
            expect(wfItem.waitingForPersonId).toBe(person._id);
            expect(wfItem.expectedBy).toBe(expectedBy);

            await gtd.flush(page);

            const bootstrap = await gtd.fetchBootstrap(page);
            const serverItem = bootstrap.items.find((i) => i._id === wfItem._id);
            expect(serverItem?.status).toBe('waitingFor');
            expect(serverItem?.waitingForPersonId).toBe(person._id);

            // Person should also be on the server
            const serverPerson = bootstrap.people.find((p) => p._id === person._id);
            expect(serverPerson?.name).toBe('Alice');
        });
    });

    test('clarify to trash', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `trash-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Junk mail');
            const trashed = await gtd.clarifyToTrash(page, inbox);
            expect(trashed.status).toBe('trash');

            await gtd.flush(page);

            const bootstrap = await gtd.fetchBootstrap(page);
            const serverItem = bootstrap.items.find((i) => i._id === trashed._id);
            expect(serverItem?.status).toBe('trash');
        });
    });

    test('batch clarify multiple items to different statuses', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `batch-${dayjs().valueOf()}@example.com`, async (page) => {
            const itemA = await gtd.collect(page, 'Batch A — next action');
            const itemB = await gtd.collect(page, 'Batch B — done');
            const itemC = await gtd.collect(page, 'Batch C — trash');

            await gtd.clarifyToNextAction(page, itemA, { energy: 'medium' });
            await gtd.clarifyToDone(page, itemB);
            await gtd.clarifyToTrash(page, itemC);

            await gtd.flush(page);
            expect(await gtd.queuedOps(page)).toHaveLength(0);

            const bootstrap = await gtd.fetchBootstrap(page);
            expect(bootstrap.items.find((i) => i._id === itemA._id)?.status).toBe('nextAction');
            expect(bootstrap.items.find((i) => i._id === itemB._id)?.status).toBe('done');
            expect(bootstrap.items.find((i) => i._id === itemC._id)?.status).toBe('trash');
        });
    });
});
