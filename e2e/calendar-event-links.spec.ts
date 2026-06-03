import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Exercises the CalendarEventLinks read-only block on a calendar item: the conferencing join link
// (labeled per provider), the location, and the "Open in Google Calendar" deep link. We seed a
// calendar item with the GCal-owned fields via gtd.updateItem (no GCal round-trip needed) and open
// the editor via the calendar row's Edit affordance. A second case asserts the block self-suppresses
// when none of the fields are present.

test.describe('Calendar — event links (meeting link, location, open-in-GCal)', () => {
    test('shows the Meet join link, location, and open-in-Google-Calendar link', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `event-links-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Weekly standup');
            const start = dayjs().add(1, 'day').hour(9).minute(0).second(0).millisecond(0).toISOString();
            const end = dayjs(start).add(15, 'minute').toISOString();
            const calItem = await gtd.clarifyToCalendar(page, inbox, { timeStart: start, timeEnd: end });

            await gtd.updateItem(page, {
                ...calItem,
                meetingLink: 'https://meet.google.com/abc-defg-hij',
                location: 'HQ Room 4B',
                htmlLink: 'https://calendar.google.com/event?eid=standup',
                updatedTs: dayjs().toISOString(),
            });

            await page.goto('/calendar');
            await page.waitForSelector('text=Weekly standup');

            await page.getByTestId('calendarItemEditButton').first().click();
            const dialog = page.getByRole('dialog');
            await expect(dialog).toBeVisible();

            // Join link is labeled per provider and points at the Meet URL in a new tab.
            const join = dialog.getByTestId('meetingLinkButton');
            await expect(join).toBeVisible();
            await expect(join).toHaveText('Join Google Meet');
            await expect(join).toHaveAttribute('href', 'https://meet.google.com/abc-defg-hij');
            await expect(join).toHaveAttribute('target', '_blank');
            await expect(join).toHaveAttribute('rel', /noopener/);

            await expect(dialog.getByTestId('eventLocation')).toHaveText('HQ Room 4B');

            const openInGcal = dialog.getByTestId('openInGCalLink');
            await expect(openInGcal).toHaveAttribute('href', 'https://calendar.google.com/event?eid=standup');
            await expect(openInGcal).toHaveAttribute('target', '_blank');
        });
    });

    test('renders no meeting-link / location affordances when the item carries none', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `event-links-empty-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Solo focus block');
            const start = dayjs().add(1, 'day').hour(14).minute(0).second(0).millisecond(0).toISOString();
            const end = dayjs(start).add(1, 'hour').toISOString();
            await gtd.clarifyToCalendar(page, inbox, { timeStart: start, timeEnd: end });

            await page.goto('/calendar');
            await page.waitForSelector('text=Solo focus block');

            await page.getByTestId('calendarItemEditButton').first().click();
            const dialog = page.getByRole('dialog');
            await expect(dialog).toBeVisible();

            await expect(dialog.getByTestId('meetingLinkButton')).toHaveCount(0);
            await expect(dialog.getByTestId('eventLocation')).toHaveCount(0);
            await expect(dialog.getByTestId('openInGCalLink')).toHaveCount(0);
        });
    });
});
