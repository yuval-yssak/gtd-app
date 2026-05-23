import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Regression for the "moved-twice silent loss" bug: a user moves a recurring-series instance in
// Google Calendar (e.g. Tue 09:00 → Sun 12:30), then moves it AGAIN (Sun → Mon). Pre-fix the
// second move's exception was keyed on the original Tue date but the item's `timeStart` had
// already been shifted, so the date-keyed lookup found nothing and the move was silently lost.
//
// Drives `applyExceptionToItems` directly via /dev/calendar/simulate-routine-exception — the same
// helper `syncRoutineExceptions` invokes for each entry `getExceptions` returns. Faster than
// orchestrating a real GCal push and decouples this test from Google's webhook delivery.

const DEV_SEED_INTEGRATION_URL = 'http://localhost:4000/dev/calendar/seed-integration';
const DEV_SIMULATE_EXCEPTION_URL = 'http://localhost:4000/dev/calendar/simulate-routine-exception';

interface SeedResponse {
    integrationId: string;
    configIds: string[];
}

async function seedIntegration(userId: string): Promise<SeedResponse> {
    const res = await fetch(DEV_SEED_INTEGRATION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, calendars: [{ calendarId: 'primary', isDefault: true, displayName: 'Primary' }] }),
    });
    if (!res.ok) {
        throw new Error(`seed-integration ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as SeedResponse;
}

async function simulateRoutineException(body: {
    userId: string;
    routineId: string;
    exception: { originalDate: string; type: 'modified' | 'deleted'; googleEventId?: string; newTimeStart?: string; newTimeEnd?: string; title?: string };
}): Promise<void> {
    const res = await fetch(DEV_SIMULATE_EXCEPTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        throw new Error(`simulate-routine-exception ${res.status}: ${await res.text()}`);
    }
}

async function pullAndFindRoutineItems(page: Page, routineId: string) {
    await gtd.pull(page);
    const items = await gtd.listItems(page);
    return items.filter((i) => i.routineId === routineId && i.status !== 'trash');
}

test.describe('calendar — recurring instance moved twice', () => {
    test('second move lands on the (already-shifted) item; no duplicate is created', async ({ browser }) => {
        const email = `moved-twice-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            const userId = (await gtd.getActiveAccountId(page)) as string;
            const seeded = await seedIntegration(userId);

            // Create a calendar routine linked to a GCal master event id. The routine's
            // calendarItemTemplate.timeOfDay is the wall-clock time used to compute instance ids.
            const masterEventId = `gcal-master-moved-twice-${dayjs().valueOf()}`;
            const routine = await gtd.createRoutine(page, {
                userId,
                title: 'Yuval <> Gilad',
                routineType: 'calendar',
                rrule: 'FREQ=WEEKLY;BYDAY=TU',
                template: {},
                active: true,
                calendarItemTemplate: { timeOfDay: '09:00', duration: 60 },
                calendarIntegrationId: seeded.integrationId,
                calendarSyncConfigId: seeded.configIds[0],
                calendarEventId: masterEventId,
            });

            // Seed a single calendar item matching the May 19 (Tue) occurrence with the
            // calendarInstanceEventId the server now generates for fresh items. Pre-rollout we
            // would have skipped this and exercised the date-keyed fallback — kept as a separate
            // spec dimension if needed later.
            const originalDate = '2026-05-19';
            const instanceEventId = `${masterEventId}_20260519T060000Z`; // 09:00 Asia/Jerusalem = 06:00 UTC
            const seededItem = await gtd.collect(page, 'Yuval <> Gilad');
            const calendarItem = await gtd.clarifyToCalendar(page, seededItem, {
                timeStart: `${originalDate}T09:00:00`,
                timeEnd: `${originalDate}T10:00:00`,
                calendarIntegrationId: seeded.integrationId,
                calendarSyncConfigId: seeded.configIds[0],
            });
            await gtd.updateItem(page, { ...calendarItem, routineId: routine._id, calendarInstanceEventId: instanceEventId });
            await gtd.flush(page);

            // FIRST move: May 19 → May 24 12:30.
            await simulateRoutineException({
                userId,
                routineId: routine._id,
                exception: {
                    originalDate,
                    type: 'modified',
                    googleEventId: instanceEventId,
                    newTimeStart: '2026-05-24T12:30:00Z',
                    newTimeEnd: '2026-05-24T14:00:00Z',
                },
            });
            await expect
                .poll(async () => {
                    const items = await pullAndFindRoutineItems(page, routine._id);
                    return items.find((i) => i._id === calendarItem._id)?.timeStart;
                })
                .toBe('2026-05-24T12:30:00Z');

            // SECOND move: same originalDate, now → May 25 11:00. The bug surfaces here.
            await simulateRoutineException({
                userId,
                routineId: routine._id,
                exception: {
                    originalDate,
                    type: 'modified',
                    googleEventId: instanceEventId,
                    newTimeStart: '2026-05-25T11:00:00Z',
                    newTimeEnd: '2026-05-25T12:00:00Z',
                },
            });
            await expect
                .poll(async () => {
                    const items = await pullAndFindRoutineItems(page, routine._id);
                    return items.find((i) => i._id === calendarItem._id)?.timeStart;
                })
                .toBe('2026-05-25T11:00:00Z');

            // CRITICAL: no duplicate item was created for the routine.
            const finalRoutineItems = await pullAndFindRoutineItems(page, routine._id);
            expect(finalRoutineItems).toHaveLength(1);
            const [final] = finalRoutineItems;
            if (!final) throw new Error('expected one routine item');
            expect(final._id).toBe(calendarItem._id);
            expect(final.timeStart).toBe('2026-05-25T11:00:00Z');
        });
    });
});
