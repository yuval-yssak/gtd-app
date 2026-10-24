import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Exercises the Phase 6 MeetingDetails accordion. We seed a calendar item with attendees +
// organizer via gtd.updateItem (no GCal round-trip required) and verify the accordion mounts,
// the response tally is correct, and per-attendee chip color matches responseStatus. The item
// page renders the accordion inside the editor body; we reach it via the calendar list row's
// Edit affordance.

test.describe('Calendar — MeetingDetails accordion', () => {
    test('renders with organizer + attendees, shows tally, and colors chips by responseStatus', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `meeting-details-${dayjs().valueOf()}@example.com`, async (page) => {
            // Seed a timed calendar item first via the standard clarify flow so its baseline shape
            // (status, calendar* fields) matches what the inbound parser would have produced.
            const inbox = await gtd.collect(page, 'Quarterly planning');
            const start = dayjs().add(1, 'day').hour(10).minute(0).second(0).millisecond(0).toISOString();
            const end = dayjs(start).add(1, 'hour').toISOString();
            const calItem = await gtd.clarifyToCalendar(page, inbox, { timeStart: start, timeEnd: end });

            // Stamp attendees + organizer directly. The accordion mounts on either signal so we
            // include both for realism. Three attendees across three responseStatuses lets us
            // verify the summary tally captures all three buckets.
            const enriched = {
                ...calItem,
                organizer: { email: 'org@example.com', displayName: 'Olive Organizer' },
                attendees: [
                    { email: 'me@example.com', responseStatus: 'accepted' as const, self: true },
                    { email: 'b@example.com', responseStatus: 'declined' as const },
                    { email: 'c@example.com', responseStatus: 'tentative' as const },
                ],
                updatedTs: dayjs().toISOString(),
            };
            await gtd.updateItem(page, enriched);

            await page.goto('/calendar');
            await page.waitForSelector('text=Quarterly planning');

            // Open the editor (the item page) via the row's Edit button.
            await page.getByTestId('calendarItemEditButton').first().click();
            const editor = page.getByTestId('itemPageWrapper');
            await expect(editor).toBeVisible();

            // Accordion mounts inside the editor body. testid pins the contract.
            const accordion = editor.getByTestId('meetingDetails');
            await expect(accordion).toBeVisible();

            // Aggregate tally formatted by formatResponseSummary: "1 accepted · 1 declined · 1 tentative".
            // Loose substring matches keep the test resilient to the exact separator. The summary
            // renders in the collapsed accordion header so no expansion is required here.
            const summary = editor.getByTestId('meetingDetailsSummary');
            await expect(summary).toContainText('1 accepted');
            await expect(summary).toContainText('1 declined');
            await expect(summary).toContainText('1 tentative');

            // The panel starts collapsed: the body stays mounted but hidden, so the chips are not visible
            // until the summary (a disclosure button) is pressed.
            await expect(summary).toHaveAttribute('aria-expanded', 'false');
            await expect(editor.getByTestId('attendeesList')).toBeHidden();
            await summary.click();
            await expect(summary).toHaveAttribute('aria-expanded', 'true');

            // Chip presence pinned by per-email testid. Colour verification: the chip carries its RSVP
            // tone as `data-tone` — more stable than reading the computed CSS colour. One chip per
            // status proves the mapping.
            const acceptedChip = editor.getByTestId('attendeeChip-me@example.com');
            await expect(acceptedChip).toBeVisible();
            await expect(acceptedChip).toHaveAttribute('data-tone', 'success');

            const declinedChip = editor.getByTestId('attendeeChip-b@example.com');
            await expect(declinedChip).toHaveAttribute('data-tone', 'error');

            const tentativeChip = editor.getByTestId('attendeeChip-c@example.com');
            await expect(tentativeChip).toHaveAttribute('data-tone', 'warning');
        });
    });

    test('the attendee editor adds by suggestion or typed email, asks for a missing email, and removes', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `meeting-attendees-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.createPerson(page, { name: 'Dana Levi', email: 'dana@example.com' });
            await gtd.createPerson(page, { name: 'Noam Nomail' });
            const inbox = await gtd.collect(page, 'Design review');
            const start = dayjs().add(1, 'day').hour(14).minute(0).second(0).millisecond(0).toISOString();
            const calItem = await gtd.clarifyToCalendar(page, inbox, { timeStart: start, timeEnd: dayjs(start).add(1, 'hour').toISOString() });
            await gtd.updateItem(page, {
                ...calItem,
                organizer: { email: 'me@example.com', displayName: 'Me' },
                attendees: [
                    { email: 'me@example.com', responseStatus: 'accepted' as const, self: true },
                    { email: 'guest@example.com', responseStatus: 'needsAction' as const },
                ],
                updatedTs: dayjs().toISOString(),
            });
            await gtd.flush(page);

            await page.goto(`/item/${calItem._id}`);
            const editor = page.getByTestId('itemPageWrapper');
            await editor.getByTestId('meetingDetailsSummary').click();
            const attendeeEmails = async () => ((await gtd.listItems(page)).find((i) => i._id === calItem._id)?.attendees ?? []).map((a) => a.email);
            const picker = editor.getByRole('combobox', { name: 'Add attendee' });

            // The own chip can be neither removed nor promoted; a guest's can.
            await expect(editor.getByTestId('attendeeChip-me@example.com').getByRole('button')).toHaveCount(0);
            // The label is the click target (named by its text; the title says what a click does).
            await expect(editor.getByTestId('attendeeChip-guest@example.com').getByRole('button', { name: 'guest@example.com', exact: true })).toHaveAttribute(
                'title',
                'Save as person',
            );

            // A suggestion picked by click adds the person under their stored email.
            await picker.fill('dan');
            await page.getByRole('option', { name: /Dana Levi/ }).click();
            await expect.poll(attendeeEmails).toContain('dana@example.com');
            await expect(picker).toHaveValue('');

            // A typed email with nothing highlighted is added on Enter.
            await picker.fill('new@example.com');
            await picker.press('Enter');
            await expect.poll(attendeeEmails).toContain('new@example.com');

            // Text that is not an email is not added; it stays in the field to be corrected.
            await picker.fill('not an email');
            await picker.press('Enter');
            await expect(picker).toHaveValue('not an email');

            // A person with no email asks for one before joining.
            await picker.fill('noam');
            await page.getByRole('option', { name: /Noam Nomail/ }).click();
            await expect(editor.getByTestId('addEmailToPersonRow')).toBeVisible();

            // Remove takes the guest off the meeting.
            await editor.getByRole('button', { name: 'Remove guest@example.com' }).click();
            // The final roster also proves the non-email text was never added.
            await expect.poll(async () => (await attendeeEmails()).sort()).toEqual(['dana@example.com', 'me@example.com', 'new@example.com']);
        });
    });
});
