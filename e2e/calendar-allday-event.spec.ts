import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Exercises the Phase 5 all-day form + Phase 7 calendar route. The user creates a single-day all-day
// item via the form's new toggle; we then assert IDB stores it with the GCal-exclusive end-date
// convention (`+1 day`) and that the calendar route pins the "All day" chip at the top of the day
// group. Multi-day all-day, RSVP, and OAuth re-consent are deferred — those require the sandbox
// GCal test account (see project_gtd_test_gcal_url.md).

test.describe('Calendar — all-day events', () => {
    test('clarify-to-calendar with allDay:true stores YYYY-MM-DD dates and renders the All day chip', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `allday-event-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'All-day single day');
            // Tomorrow as the inclusive single-day target. The form encodes timeEnd as
            // start + 1 day (GCal exclusive-end), so we round-trip both ends.
            const startDate = dayjs().add(1, 'day').format('YYYY-MM-DD');
            const expectedEndExclusive = dayjs(startDate).add(1, 'day').format('YYYY-MM-DD');
            await gtd.clarifyToCalendar(page, inbox, {
                timeStart: startDate,
                timeEnd: expectedEndExclusive,
                allDay: true,
            });

            // ── IDB invariants ───────────────────────────────────────────────────
            const items = await gtd.listItems(page);
            const stored = items.find((i) => i._id === inbox._id);
            expect(stored?.status).toBe('calendar');
            expect(stored?.allDay).toBe(true);
            expect(stored?.timeStart).toBe(startDate);
            expect(stored?.timeEnd).toBe(expectedEndExclusive);
            // YYYY-MM-DD shape (no `T`) — proves we didn't accidentally land on a timed encoding.
            expect(stored?.timeStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(stored?.timeEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);

            // ── Route render ──────────────────────────────────────────────────────
            await page.goto('/calendar');
            await page.waitForSelector('text=All-day single day');
            // The All day chip from TimeColumn surfaces under each all-day item.
            const chip = page.getByTestId('calendarRowAllDayChip').first();
            await expect(chip).toBeVisible();
            await expect(chip).toHaveText('All day');
            // Single-day: no range label. Multi-day surfaces calendarRowAllDayRange — keep the
            // assertion narrow so this spec stays single-day-focused.
            await expect(page.getByTestId('calendarRowAllDayRange')).toHaveCount(0);
        });
    });
});
