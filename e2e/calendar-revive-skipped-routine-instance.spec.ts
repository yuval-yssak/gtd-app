import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

dayjs.extend(utc);
dayjs.extend(timezone);

// Regression for the "un-deleted (revived) routine instance from GCal" plan
// (docs/plans/reconcile-undeleted-routine-instances.md). Symmetric sibling of the moved-back-to-
// master time-move reconcile that shipped in 3c7eda9.
//
// A user deletes a routine-generated recurring instance in Google Calendar — that records a local
// `skipped` routineException and trashes the generated item. Later they un-delete / recreate that
// single occurrence. GCal stops reporting the date as a `cancelled` exception, so its absence from
// the reported deleted set means "the occurrence is back": the trashed item must be revived to
// master time and the `skipped` exception dropped.
//
// Drives the deletion via /dev/calendar/simulate-routine-exception (one `deleted` exception through
// applyExceptionToItems) and the revival via /dev/calendar/simulate-routine-exception-sync (the FULL
// reconcile path with a caller-controlled `reported` set, standing in for provider.getExceptions
// which needs a live Google account). End-to-end assertion: the item disappears from /calendar then
// reappears at master time after the revival, with the skipped exception gone.

const DEV_SEED_INTEGRATION_URL = 'http://localhost:4000/dev/calendar/seed-integration';
const DEV_SIMULATE_SYNC_URL = 'http://localhost:4000/dev/calendar/simulate-routine-exception-sync';

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

/** Drives the full reconcile path with the given `reported` set (empty = GCal dropped the tombstone). */
async function simulateRoutineExceptionSync(body: {
    userId: string;
    routineId: string;
    reported: Array<{ originalDate: string; type: 'modified' | 'deleted'; googleEventId?: string }>;
    timeZone?: string;
}): Promise<void> {
    const res = await fetch(DEV_SIMULATE_SYNC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        throw new Error(`simulate-routine-exception-sync ${res.status}: ${await res.text()}`);
    }
}

async function pullAndFindRoutineItems(page: Page, routineId: string) {
    await gtd.pull(page);
    const items = await gtd.listItems(page);
    return items.filter((i) => i.routineId === routineId);
}

/** The next upcoming Monday (strictly future), as YYYY-MM-DD — an occurrence of the FREQ=WEEKLY;BYDAY=MO rrule. */
function nextMonday(): string {
    const today = dayjs().startOf('day');
    const daysUntilMonday = (8 - today.day()) % 7 || 7;
    return today.add(daysUntilMonday, 'day').format('YYYY-MM-DD');
}

test.describe('calendar — un-deleted (revived) routine instance from GCal', () => {
    test('reviving a GCal-deleted occurrence restores the trashed item to master time and drops the skipped exception', async ({ browser }) => {
        const email = `revive-skipped-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            const userId = (await gtd.getActiveAccountId(page)) as string;
            const seeded = await seedIntegration(userId);

            const masterEventId = `gcal-master-revive-${dayjs().valueOf()}`;
            const routine = await gtd.createRoutine(page, {
                title: 'Standup',
                routineType: 'calendar',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                template: {},
                active: true,
                calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
                calendarIntegrationId: seeded.integrationId,
                calendarSyncConfigId: seeded.configIds[0],
                calendarEventId: masterEventId,
            } as Parameters<typeof gtd.createRoutine>[1]);

            // Seed the occurrence item for the next Monday at master time (09:00 Asia/Jerusalem),
            // linked to the routine + the instance id the server generates.
            const date = nextMonday();
            // Mirror the server's buildCalendarInstanceEventId: original 09:00 occurrence in the
            // calendar TZ, converted to the YYYYMMDDTHHMMSSZ basic-ISO form GCal uses for instance ids.
            const instanceEventId = `${masterEventId}_${dayjs.tz(`${date}T09:00:00`, 'Asia/Jerusalem').utc().format('YYYYMMDDTHHmmss[Z]')}`;
            const seededItem = await gtd.collect(page, 'Standup');
            const calendarItem = await gtd.clarifyToCalendar(page, seededItem, {
                timeStart: `${date}T09:00:00`,
                timeEnd: `${date}T09:30:00`,
                calendarIntegrationId: seeded.integrationId,
                calendarSyncConfigId: seeded.configIds[0],
            });
            await gtd.updateItem(page, { ...calendarItem, routineId: routine._id, calendarInstanceEventId: instanceEventId });
            await gtd.flush(page);

            // DELETE the occurrence in GCal → trashes the item + records a `skipped` exception. Drive
            // the full reconcile (not applyExceptionToItems alone) so the `skipped` exception is merged
            // into the routine — that's what the later revival reconciler keys off.
            await simulateRoutineExceptionSync({
                userId,
                routineId: routine._id,
                reported: [{ originalDate: date, type: 'deleted', googleEventId: instanceEventId }],
                timeZone: 'Asia/Jerusalem',
            });
            await expect.poll(async () => (await pullAndFindRoutineItems(page, routine._id)).find((i) => i._id === calendarItem._id)?.status).toBe('trash');

            // UN-DELETE in GCal: getExceptions now reports NO exceptions for the series (tombstone gone).
            await simulateRoutineExceptionSync({ userId, routineId: routine._id, reported: [], timeZone: 'Asia/Jerusalem' });

            // The occurrence is revived to master time, live again.
            await expect
                .poll(async () => (await pullAndFindRoutineItems(page, routine._id)).find((i) => i.status === 'calendar')?.timeStart)
                .toBe(`${date}T09:00:00`);

            const liveItems = (await pullAndFindRoutineItems(page, routine._id)).filter((i) => i.status === 'calendar');
            expect(liveItems).toHaveLength(1);
            const [revived] = liveItems;
            if (!revived) throw new Error('expected one revived routine item');
            // Revived in place — same item id, instance id re-minted.
            expect(revived._id).toBe(calendarItem._id);
            expect(revived.calendarInstanceEventId).toBe(instanceEventId);

            // The skipped exception was dropped from the routine.
            const routines = await gtd.listRoutines(page);
            const updatedRoutine = routines.find((r) => r._id === routine._id);
            expect((updatedRoutine?.routineExceptions ?? []).some((e) => e.date === date && e.type === 'skipped')).toBe(false);
        });
    });
});
