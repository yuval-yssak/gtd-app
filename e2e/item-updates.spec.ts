import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Tests item mutations after initial clarification:
// metadata updates, title/notes changes, and cross-status moves.

test.describe('item updates', () => {
    test('update next-action metadata', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `update-meta-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Update me');
            const na = await gtd.clarifyToNextAction(page, inbox, { energy: 'low', time: 5 });

            const updated = await gtd.updateItem(page, { ...na, energy: 'high', time: 30, urgent: true });
            expect(updated.energy).toBe('high');
            expect(updated.time).toBe(30);
            expect(updated.urgent).toBe(true);

            await gtd.flush(page);

            const bootstrap = await gtd.fetchBootstrap(page);
            const serverItem = bootstrap.items.find((i) => i._id === updated._id);
            expect(serverItem?.energy).toBe('high');
            expect(serverItem?.time).toBe(30);
            expect(serverItem?.urgent).toBe(true);
        });
    });

    test('update item title and notes', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `update-title-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Original title');
            const na = await gtd.clarifyToNextAction(page, inbox);

            const updated = await gtd.updateItem(page, { ...na, title: 'Revised title', notes: '# Heading\nSome notes' });
            expect(updated.title).toBe('Revised title');
            expect(updated.notes).toBe('# Heading\nSome notes');

            await gtd.flush(page);

            const bootstrap = await gtd.fetchBootstrap(page);
            const serverItem = bootstrap.items.find((i) => i._id === updated._id);
            expect(serverItem?.title).toBe('Revised title');
            expect(serverItem?.notes).toBe('# Heading\nSome notes');
        });
    });

    test('move next-action to done', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-done-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Finish this');
            const na = await gtd.clarifyToNextAction(page, inbox, { energy: 'medium' });
            await gtd.flush(page);

            const done = await gtd.clarifyToDone(page, na);
            expect(done.status).toBe('done');
            await gtd.flush(page);

            const bootstrap = await gtd.fetchBootstrap(page);
            expect(bootstrap.items.find((i) => i._id === done._id)?.status).toBe('done');
        });
    });

    test('move next-action to waiting-for', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-wf-${dayjs().valueOf()}@example.com`, async (page) => {
            const person = await gtd.createPerson(page, { name: 'Bob' });
            const inbox = await gtd.collect(page, 'Delegate to Bob');
            const na = await gtd.clarifyToNextAction(page, inbox, { energy: 'low' });

            const wf = await gtd.clarifyToWaitingFor(page, na, { waitingForPersonId: person._id });
            expect(wf.status).toBe('waitingFor');
            expect(wf.waitingForPersonId).toBe(person._id);
            // nextAction-specific fields should be stripped
            expect(wf.energy).toBeUndefined();

            await gtd.flush(page);

            const bootstrap = await gtd.fetchBootstrap(page);
            const serverItem = bootstrap.items.find((i) => i._id === wf._id);
            expect(serverItem?.status).toBe('waitingFor');
            expect(serverItem?.waitingForPersonId).toBe(person._id);
        });
    });

    test('move calendar item to trash', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `cal-trash-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Cancel meeting');
            const timeStart = dayjs().add(2, 'day').hour(14).minute(0).second(0).toISOString();
            const timeEnd = dayjs().add(2, 'day').hour(15).minute(0).second(0).toISOString();
            const cal = await gtd.clarifyToCalendar(page, inbox, { timeStart, timeEnd });
            await gtd.flush(page);

            const trashed = await gtd.clarifyToTrash(page, cal);
            expect(trashed.status).toBe('trash');
            await gtd.flush(page);

            const bootstrap = await gtd.fetchBootstrap(page);
            expect(bootstrap.items.find((i) => i._id === trashed._id)?.status).toBe('trash');
        });
    });

    test('move inbox item to someday/maybe', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `inbox-someday-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Learn a new instrument');

            const someday = await gtd.clarifyToSomedayMaybe(page, inbox);
            expect(someday.status).toBe('somedayMaybe');
            await gtd.flush(page);

            const bootstrap = await gtd.fetchBootstrap(page);
            const serverItem = bootstrap.items.find((i) => i._id === someday._id);
            expect(serverItem?.status).toBe('somedayMaybe');
        });
    });

    test('move next-action to someday/maybe — status-specific fields stripped', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-someday-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Maybe someday');
            const na = await gtd.clarifyToNextAction(page, inbox, { energy: 'high', time: 45, urgent: true });
            await gtd.flush(page);

            const someday = await gtd.clarifyToSomedayMaybe(page, na);
            expect(someday.status).toBe('somedayMaybe');
            // Status-specific fields should be stripped by the clarify helper.
            expect(someday.energy).toBeUndefined();
            expect(someday.time).toBeUndefined();
            expect(someday.urgent).toBeUndefined();

            await gtd.flush(page);
            const bootstrap = await gtd.fetchBootstrap(page);
            const serverItem = bootstrap.items.find((i) => i._id === someday._id);
            expect(serverItem?.status).toBe('somedayMaybe');
            expect(serverItem?.energy).toBeUndefined();
        });
    });

    test('move someday/maybe back to inbox', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `someday-inbox-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Reconsider this');
            const someday = await gtd.clarifyToSomedayMaybe(page, inbox);
            await gtd.flush(page);

            const back = await gtd.clarifyToInbox(page, someday);
            expect(back.status).toBe('inbox');

            await gtd.flush(page);
            const bootstrap = await gtd.fetchBootstrap(page);
            expect(bootstrap.items.find((i) => i._id === back._id)?.status).toBe('inbox');
        });
    });
});
