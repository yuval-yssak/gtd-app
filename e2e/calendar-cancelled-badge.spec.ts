import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Exercises the Phase 7 "Cancelled in Calendar" badge in the ArchivedItemsView (rendered by /trash
// and /done). We seed an item with cancelledByGCal:true in trash via the standard helpers and
// confirm the chip mounts. Full inbound cancellation flow (webhook → trash + cancelledByGCal) is
// covered by server-side tests; this spec verifies the client-side render contract end-to-end.

test.describe('Calendar — cancelled-by-GCal badge', () => {
    test('ArchivedItemsView renders the "Cancelled in Calendar" chip on trashed items with cancelledByGCal:true', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `cancelled-badge-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Booked but cancelled');
            // Take the item through calendar → trash via the standard helpers so its shape matches
            // what the inbound cancellation handler would emit.
            const start = dayjs().add(1, 'day').toISOString();
            const end = dayjs(start).add(30, 'minute').toISOString();
            const calItem = await gtd.clarifyToCalendar(page, inbox, { timeStart: start, timeEnd: end });
            const trashed = await gtd.clarifyToTrash(page, calItem);

            // Stamp cancelledByGCal:true — the field is server-set during inbound webhook handling.
            // Seeding it directly keeps this spec independent of a live GCal round-trip.
            const cancelled = { ...trashed, cancelledByGCal: true, updatedTs: dayjs().toISOString() };
            await gtd.updateItem(page, cancelled);

            await page.goto('/trash');
            await page.waitForSelector('text=Booked but cancelled');

            // The badge mounts under the title row whenever cancelledByGCal === true. Locate by the
            // testid pinned in ArchivedItemsView (Phase 7) so the test stays resilient to label edits.
            const badge = page.getByTestId('cancelledByGCalChip').first();
            await expect(badge).toBeVisible();
            await expect(badge).toHaveText('Cancelled in Calendar');
        });
    });
});
