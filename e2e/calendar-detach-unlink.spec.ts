import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withTwoLoggedInDevices } from './helpers/context';
import { gtd } from './helpers/gtd';

const API_URL = 'http://localhost:4000';

/**
 * Regression coverage for calendar → active-status detach (orphaned-GCal-event bug).
 *
 * Converting a GCal-linked calendar item to nextAction/somedayMaybe/etc. strips the GCal
 * linkage off the snapshot, so the server now hydrates the pre-update row onto the op as a
 * `detachedCalendar` sidecar and removes the GCal event from it. The actual `deleteEvent`
 * provider call is asserted in `api-server/src/tests/calendarDetachGCalCascade.test.ts` with a
 * mocked provider (no GCal in the e2e dev stack). This spec covers the wire-level half:
 * a sidecar-carrying op must replicate cleanly to another device, and the PATCH response must
 * already reflect the stripped calendar fields.
 */
test.describe('calendar item detach (calendar → nextAction)', () => {
    test('linked calendar item PATCHed to nextAction syncs to a second device', async ({ browser }) => {
        const email = `cal-detach-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            const inbox = await gtd.collect(page1, 'Detach me from GCal');
            const calItem = await gtd.clarifyToCalendar(page1, inbox, {
                timeStart: dayjs().add(1, 'day').hour(9).minute(0).second(0).millisecond(0).toISOString(),
                timeEnd: dayjs().add(1, 'day').hour(9).minute(30).second(0).millisecond(0).toISOString(),
            });
            await gtd.flush(page1);

            // Mint a bearer token via the page's session and link the item to a (fake) GCal event —
            // `calendarEventId` is what makes the server treat the later status change as a detach.
            const mint = await page1.context().request.post(`${API_URL}/account/tokens`, {
                data: { label: 'detach-e2e', scopes: ['items.capture', 'items.read', 'items.write'] },
            });
            expect(mint.status()).toBe(200);
            const { plaintext } = (await mint.json()) as { plaintext: string };
            const auth = { headers: { Authorization: `Bearer ${plaintext}` } };

            const link = await page1.context().request.patch(`${API_URL}/v1/items/${calItem._id}`, {
                ...auth,
                data: { calendarEventId: 'e2e-fake-gcal-evt' },
            });
            expect(link.status()).toBe(200);

            // The detach: PATCH to nextAction. sanitizeStaleFields strips the calendar linkage
            // from the row; the server hydrates it onto the op as `detachedCalendar`.
            const detach = await page1.context().request.patch(`${API_URL}/v1/items/${calItem._id}`, {
                ...auth,
                data: { status: 'nextAction', energy: 'low', ignoreBefore: dayjs().add(3, 'day').format('YYYY-MM-DD') },
            });
            expect(detach.status()).toBe(200);
            const patched = (await detach.json()) as Record<string, unknown>;
            expect(patched['status']).toBe('nextAction');
            expect(patched['calendarEventId']).toBeUndefined();
            expect(patched['timeStart']).toBeUndefined();

            // The sidecar-carrying op must apply cleanly on a second device.
            await gtd.pull(page2);
            const itemsOnDevice2 = await gtd.listItems(page2);
            const onDevice2 = itemsOnDevice2.find((i) => i._id === calItem._id);
            expect(onDevice2?.status).toBe('nextAction');
            expect(onDevice2?.calendarEventId).toBeUndefined();
        });
    });
});
