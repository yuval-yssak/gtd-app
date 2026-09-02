import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

dayjs.extend(utc);
dayjs.extend(timezone);

// Regression for the "ALL HANDS" create/trash flip-flop (staging, Sept 2026).
//
// Google Calendar reported two exceptions on one series: the week-1 occurrence MOVED onto the
// week-2 date (15:00), and the regular week-2 occurrence CANCELLED. The cancelled exception's
// item lookup missed by instance id and fell back to "any live row of this routine on that date",
// which grabbed the moved week-1 row → trashed it. The next sync found no live row for the week-1
// exception → re-created it as an orphan. Every sync produced create/update/trash ops (~1,600 dead
// rows, a push notification per cycle). The date fallback now ignores rows that already carry a
// different instance id.
//
// Drives the FULL reconcile path via /dev/calendar/simulate-routine-exception-sync with the same
// `reported` set three times (getExceptions is a time-range query — it re-reports the same
// exceptions on every sync) and asserts the moved row is stable: same id, still live, and the
// trash count does not grow.

const DEV_SEED_INTEGRATION_URL = 'http://localhost:4000/dev/calendar/seed-integration';
const DEV_SIMULATE_SYNC_URL = 'http://localhost:4000/dev/calendar/simulate-routine-exception-sync';

interface SeedResponse {
    integrationId: string;
    configIds: string[];
}

interface ReportedException {
    originalDate: string;
    type: 'modified' | 'deleted';
    googleEventId?: string;
    newTimeStart?: string;
    newTimeEnd?: string;
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

async function simulateRoutineExceptionSync(body: { userId: string; routineId: string; reported: ReportedException[]; timeZone?: string }): Promise<void> {
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

/** Mirrors the server's buildCalendarInstanceEventId for a 09:00 Asia/Jerusalem occurrence. */
function instanceIdFor(masterEventId: string, date: string): string {
    return `${masterEventId}_${dayjs.tz(`${date}T09:00:00`, 'Asia/Jerusalem').utc().format('YYYYMMDDTHHmmss[Z]')}`;
}

test.describe('calendar — moved instance landing on a cancelled occurrence date', () => {
    test('repeated syncs keep the moved row stable instead of trashing and re-creating it', async ({ browser }) => {
        const email = `moved-onto-cancelled-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            const userId = (await gtd.getActiveAccountId(page)) as string;
            const seeded = await seedIntegration(userId);

            const masterEventId = `gcal-master-allhands-${dayjs().valueOf()}`;
            const routine = await gtd.createRoutine(page, {
                title: 'ALL HANDS',
                routineType: 'calendar',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                template: {},
                active: true,
                calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
                calendarIntegrationId: seeded.integrationId,
                calendarSyncConfigId: seeded.configIds[0],
                calendarEventId: masterEventId,
            } as Parameters<typeof gtd.createRoutine>[1]);
            await gtd.flush(page);

            const movedFrom = nextMonday();
            const cancelled = dayjs(movedFrom).add(7, 'day').format('YYYY-MM-DD');
            const movedTimeStart = `${cancelled}T15:00:00+03:00`;
            const reported: ReportedException[] = [
                {
                    originalDate: movedFrom,
                    type: 'modified',
                    newTimeStart: movedTimeStart,
                    newTimeEnd: `${cancelled}T15:30:00+03:00`,
                    googleEventId: instanceIdFor(masterEventId, movedFrom),
                },
                { originalDate: cancelled, type: 'deleted', googleEventId: instanceIdFor(masterEventId, cancelled) },
            ];

            const syncAndReadBack = async () => {
                await simulateRoutineExceptionSync({ userId, routineId: routine._id, reported, timeZone: 'Asia/Jerusalem' });
                const rows = await pullAndFindRoutineItems(page, routine._id);
                return {
                    movedLive: rows.filter((i) => i.status === 'calendar' && i.timeStart === movedTimeStart),
                    trashed: rows.filter((i) => i.status === 'trash'),
                };
            };

            const first = await syncAndReadBack();
            expect(first.movedLive).toHaveLength(1);
            const [movedRow] = first.movedLive;
            if (!movedRow) throw new Error('expected the moved occurrence to be live after the first sync');
            expect(movedRow.calendarInstanceEventId).toBe(instanceIdFor(masterEventId, movedFrom));

            // Same reported set again (and again): the moved row keeps its id, stays live, and the
            // trash pile does not grow — no create/trash flip-flop.
            const second = await syncAndReadBack();
            const third = await syncAndReadBack();
            for (const run of [second, third]) {
                expect(run.movedLive.map((i) => i._id)).toEqual([movedRow._id]);
                expect(run.trashed).toHaveLength(first.trashed.length);
            }

            const routines = await gtd.listRoutines(page);
            const updatedRoutine = routines.find((r) => r._id === routine._id);
            const exceptions = updatedRoutine?.routineExceptions ?? [];
            expect(exceptions.some((e) => e.date === movedFrom && e.type === 'modified')).toBe(true);
            expect(exceptions.some((e) => e.date === cancelled && e.type === 'skipped')).toBe(true);
        });
    });
});
