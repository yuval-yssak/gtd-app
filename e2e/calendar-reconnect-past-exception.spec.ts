import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Regression for the "stale past exceptions materialize on reconnect" bug. A yearly-birthday
// routine carries `routineExceptions` from years ago (e.g. a `* […]` title edit on 2021-09-24).
// On a fresh GCal reconnect, `lastSyncedTs` is unset → `getExceptions` returns every modified
// instance since 1970. Without a past-cutoff guard, the orphan-create branch in
// `applyExceptionToItems` materializes them as ancient `calendar` items dated 2021/2022.
//
// Drives `applyExceptionToItems` directly via /dev/calendar/simulate-routine-exception — the same
// helper `syncRoutineExceptions` invokes for each entry `getExceptions` returns.

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

test.describe('calendar — reconnect does not materialize past exceptions', () => {
    test('ancient `* […]` exception on a yearly routine does NOT create a 2021-dated calendar item', async ({ browser }) => {
        const email = `past-ex-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            const userId = (await gtd.getActiveAccountId(page)) as string;
            const seeded = await seedIntegration(userId);

            const masterEventId = `gcal-master-yearly-birthday-${dayjs().valueOf()}`;
            const routine = await gtd.createRoutine(page, {
                userId,
                title: 'Yael’s Birthday',
                routineType: 'calendar',
                rrule: 'FREQ=YEARLY',
                template: {},
                active: true,
                // The staging repro routine was all-day, but `/sync/push` only accepts timed
                // templates (`timeOfDay` + `duration`). The past-cutoff behavior under test is the
                // same for both shapes — it keys on `originalDate` / `newTimeStart`, not on
                // `allDay`. Use the timed shape so the routine flushes cleanly.
                calendarItemTemplate: { timeOfDay: '09:00', duration: 60 },
                calendarIntegrationId: seeded.integrationId,
                calendarSyncConfigId: seeded.configIds[0],
                calendarEventId: masterEventId,
            });
            // Flush so the routine reaches the server before we drive the simulate endpoint —
            // /dev/calendar/simulate-routine-exception reads it directly from MongoDB.
            await gtd.flush(page);

            // Fire a stale "modified" exception dated 2021-09-24 — matches the staging repro.
            // No item exists for that occurrence, so without the guard the orphan-create branch
            // would insert a fresh ancient `calendar` row.
            await simulateRoutineException({
                userId,
                routineId: routine._id,
                exception: {
                    originalDate: '2021-09-24',
                    type: 'modified',
                    googleEventId: `${masterEventId}_20210924`,
                    title: '* [Yael’s Birthday]',
                },
            });

            await gtd.pull(page);
            const items = (await gtd.listItems(page)).filter((i) => i.routineId === routine._id);
            // CRITICAL: no ancient orphan item materialized.
            expect(items).toHaveLength(0);
        });
    });
});
