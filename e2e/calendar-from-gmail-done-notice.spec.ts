import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// Google refuses title changes on events it auto-created from Gmail but accepts a color, so the
// server marks them done by color alone (asserted with a mocked provider in
// api-server/src/tests/calendar.reconnect.test.ts — no Google in the e2e stack). This spec covers
// the user-facing half: completing such an item tells the user why there is no ✓ in the title.
test.describe('Calendar list — Gmail-created event done notice', () => {
    test('marking a fromGmail calendar item done explains the color-only marker', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `cal-fromgmail-done-${uniqueStamp()}@example.com`, async (page) => {
            const title = 'Course session from Gmail';
            const inbox = await gtd.collect(page, title);
            const start = dayjs().startOf('hour');
            const calItem = await gtd.clarifyToCalendar(page, inbox, { timeStart: start.toISOString(), timeEnd: start.add(5, 'minute').toISOString() });
            await gtd.updateItem(page, { ...calItem, eventType: 'fromGmail', calendarEventId: 'e2e-fake-gmail-evt' });
            await gtd.flush(page);

            await page.goto('/calendar');
            await expect(page.getByText(title)).toBeVisible();
            await page.getByTestId('calendarItemMarkDoneButton').first().click();

            await expect(page.getByText('Google Calendar will show this one as done by its color only')).toBeVisible();
            const stored = (await gtd.listItems(page)).find((i) => i._id === calItem._id);
            if (!stored) throw new Error('expected the calendar item');
            expect(stored.status).toBe('done');
        });
    });
});
