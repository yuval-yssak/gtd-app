import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Exercises the Phase 6 MeetingDetails accordion. We seed a calendar item with attendees +
// organizer via gtd.updateItem (no GCal round-trip required) and verify the accordion mounts,
// the response tally is correct, and per-attendee chip color matches responseStatus. The dialog
// editor mode (default) renders the accordion within the standard <dialog role>; we hit it via
// the calendar list row's Edit affordance.

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

            // Open the editor via the row's Edit button — dialog mode is the default.
            await page.getByTestId('calendarItemEditButton').first().click();
            const dialog = page.getByRole('dialog');
            await expect(dialog).toBeVisible();

            // Accordion mounts inside the dialog body. testid pins the contract.
            const accordion = dialog.getByTestId('meetingDetails');
            await expect(accordion).toBeVisible();

            // Aggregate tally formatted by formatResponseSummary: "1 accepted · 1 declined · 1 tentative".
            // Loose substring matches keep the test resilient to the exact separator. The summary
            // renders in the collapsed accordion header so no expansion is required here.
            const summary = dialog.getByTestId('meetingDetailsSummary');
            await expect(summary).toContainText('1 accepted');
            await expect(summary).toContainText('1 declined');
            await expect(summary).toContainText('1 tentative');

            // Expand the accordion so the attendee chips become visible — MUI keeps the body
            // mounted but `visibility: hidden` while collapsed, which would fail toBeVisible().
            await summary.click();

            // Chip presence pinned by per-email testid. Color verification: MUI applies the color
            // via the `MuiChip-color<Color>` class — checking the class is more stable than reading
            // the computed CSS color. (We assert one representative per status — three would be
            // redundant once the mapping is proven.)
            const acceptedChip = dialog.getByTestId('attendeeChip-me@example.com');
            await expect(acceptedChip).toBeVisible();
            await expect(acceptedChip).toHaveClass(/MuiChip-colorSuccess/);

            const declinedChip = dialog.getByTestId('attendeeChip-b@example.com');
            await expect(declinedChip).toHaveClass(/MuiChip-colorError/);

            const tentativeChip = dialog.getByTestId('attendeeChip-c@example.com');
            await expect(tentativeChip).toHaveClass(/MuiChip-colorWarning/);
        });
    });
});
