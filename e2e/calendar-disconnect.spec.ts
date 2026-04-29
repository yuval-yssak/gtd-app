import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// E2E coverage for Step 2's two-option Disconnect dialog. The dev seed endpoint produces an
// integration with FAKE OAuth tokens — any real GCal call would fail, so the test asserts that
// the disconnect path's `skipGCalDelete` flag truly short-circuits the GCal cascade.
//
// We never drive real Google OAuth from these tests. The integration row is created via
// /dev/calendar/seed-integration, then linked items/routines are created via the gtd harness.

const SETTINGS_URL = 'http://localhost:4173/settings';
const DEV_SEED_INTEGRATION_URL = 'http://localhost:4000/dev/calendar/seed-integration';
const DEV_LIST_INTEGRATIONS_URL = 'http://localhost:4000/dev/calendar/integrations';

interface SeedResponse {
    ok: boolean;
    integrationId: string;
    configIds: string[];
}

interface SeededCalendar {
    configId?: string;
    calendarId: string;
    displayName?: string;
    isDefault?: boolean;
}

/** POSTs to /dev/calendar/seed-integration. Returns the new integrationId so the test can link entities to it. */
async function seedIntegration(userId: string, calendars?: SeededCalendar[]): Promise<SeedResponse> {
    const res = await fetch(DEV_SEED_INTEGRATION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, ...(calendars ? { calendars } : {}) }),
    });
    if (!res.ok) {
        throw new Error(`seed failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as SeedResponse;
}

async function readServerIntegrationCount(userId: string): Promise<number> {
    const res = await fetch(`${DEV_LIST_INTEGRATIONS_URL}?userId=${encodeURIComponent(userId)}`);
    const body = (await res.json()) as { rows: { _id: string }[] };
    return body.rows.length;
}

/** Pulls server-side state into IDB so the test sees the freshly-seeded integration's effects locally. */
async function pullIntoLocalDB(page: Page): Promise<void> {
    await gtd.pull(page);
}

test.describe('calendar disconnect — keepLinkedEntities', () => {
    test('clears calendarIntegrationId on items and routines without trashing them', async ({ browser }) => {
        const email = `disconnect-keep-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            const userId = (await gtd.getActiveAccountId(page)) as string;
            const seeded = await seedIntegration(userId, [{ calendarId: 'primary', isDefault: true, displayName: 'Primary' }]);

            // Create a calendar item linked to the integration.
            const inboxItem = await gtd.collect(page, 'Linked event');
            const calendarItem = await gtd.clarifyToCalendar(page, inboxItem, {
                timeStart: dayjs().add(1, 'day').toISOString(),
                timeEnd: dayjs().add(1, 'day').add(30, 'minute').toISOString(),
                calendarIntegrationId: seeded.integrationId,
                calendarSyncConfigId: seeded.configIds[0],
            });

            // Create a calendar routine linked to the same integration. routineMutations doesn't
            // make a real GCal call — it just stores the linkage in IDB.
            const routine = await gtd.createRoutine(page, {
                userId,
                title: 'Linked routine',
                routineType: 'calendar',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                template: {},
                active: true,
                calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
                calendarIntegrationId: seeded.integrationId,
                calendarSyncConfigId: seeded.configIds[0],
            });
            await gtd.flush(page);

            // Drive the disconnect via the Settings UI: open dialog → keep radio (default) → confirm.
            await page.goto(SETTINGS_URL);
            // The integration row renders a "Disconnect" button. Wait explicitly so a slow
            // /calendar/integrations fetch under parallel-runner contention doesn't fail us.
            await expect(page.getByRole('button', { name: 'Disconnect' }).first()).toBeVisible({ timeout: 10_000 });
            await page.getByRole('button', { name: 'Disconnect' }).first().click();
            const dialog = page.getByRole('dialog', { name: 'Disconnect Google Calendar' });
            await expect(dialog).toBeVisible();
            // keepLinkedEntities is the default radio; click the dialog's Disconnect to confirm.
            await dialog.getByRole('button', { name: 'Disconnect' }).click();

            // Wait for the row to disappear from settings — strongest signal the request completed.
            await expect.poll(() => readServerIntegrationCount(userId)).toBe(0);

            // Pull server state to refresh IDB (the unlink ops were recorded server-side). Poll
            // because syncAndRefresh's own concurrent pull (kicked off by onConfirm) races our forcePull.
            await expect
                .poll(async () => {
                    await pullIntoLocalDB(page);
                    const items = await gtd.listItems(page);
                    return items.find((i) => i._id === calendarItem._id)?.calendarIntegrationId;
                })
                .toBeUndefined();

            const items = await gtd.listItems(page);
            const persistedItem = items.find((i) => i._id === calendarItem._id);
            // Status preserved.
            expect(persistedItem?.status).toBe('calendar');

            const routines = await gtd.listRoutines(page);
            const persistedRoutine = routines.find((r) => r._id === routine._id);
            expect(persistedRoutine?.calendarIntegrationId).toBeUndefined();
        });
    });
});

test.describe('calendar disconnect — removeLinkedEntities', () => {
    test('trashes items and cascades routine-generated items, never invoking GCal', async ({ browser }) => {
        const email = `disconnect-remove-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            const userId = (await gtd.getActiveAccountId(page)) as string;
            const seeded = await seedIntegration(userId, [{ calendarId: 'primary', isDefault: true, displayName: 'Primary' }]);

            // Standalone calendar item linked to the integration.
            const inbox = await gtd.collect(page, 'One-off meeting');
            const standaloneItem = await gtd.clarifyToCalendar(page, inbox, {
                timeStart: dayjs().add(2, 'day').toISOString(),
                timeEnd: dayjs().add(2, 'day').add(45, 'minute').toISOString(),
                calendarIntegrationId: seeded.integrationId,
                calendarSyncConfigId: seeded.configIds[0],
            });

            // Routine + a generated item linked to the integration. Faking the generated item
            // directly via updateItem is reliable; the production cascade marks it trash via
            // pushRoutineDeletion in trashRoutinesForIntegration. The fake calendarEventId tests
            // the skipGCalDelete short-circuit — a real call would hit /calendar/v3 with bogus
            // tokens and 401, surfacing the regression.
            const routine = await gtd.createRoutine(page, {
                userId,
                title: 'Daily standup',
                routineType: 'calendar',
                rrule: 'FREQ=DAILY',
                template: {},
                active: true,
                calendarItemTemplate: { timeOfDay: '09:00', duration: 15 },
                calendarIntegrationId: seeded.integrationId,
                calendarSyncConfigId: seeded.configIds[0],
                calendarEventId: 'gcal-master-fake-id',
            });
            const inboxGenerated = await gtd.collect(page, 'Standup occurrence');
            const generatedItem = await gtd.clarifyToCalendar(page, inboxGenerated, {
                timeStart: dayjs().add(1, 'day').toISOString(),
                timeEnd: dayjs().add(1, 'day').add(15, 'minute').toISOString(),
                calendarIntegrationId: seeded.integrationId,
                calendarSyncConfigId: seeded.configIds[0],
            });
            // Attach the routineId so the trashRoutinesForIntegration cascade picks it up.
            await gtd.updateItem(page, { ...generatedItem, routineId: routine._id });
            await gtd.flush(page);

            // Drive the disconnect via the Settings UI with the Remove radio.
            await page.goto(SETTINGS_URL);
            await expect(page.getByRole('button', { name: 'Disconnect' }).first()).toBeVisible({ timeout: 10_000 });
            await page.getByRole('button', { name: 'Disconnect' }).first().click();
            const dialog = page.getByRole('dialog', { name: 'Disconnect Google Calendar' });
            await expect(dialog).toBeVisible();
            await dialog.getByText(/Remove calendar items and calendar routines from GTD/).click();
            await dialog.getByRole('button', { name: 'Disconnect' }).click();

            await expect.poll(() => readServerIntegrationCount(userId)).toBe(0);

            // Pull server state — trashRoutinesForIntegration recorded ops with status=trash.
            // Poll because syncAndRefresh's own concurrent pull (kicked off by onConfirm) may
            // still be in flight when our forcePull arrives; without polling we race the two.
            await expect
                .poll(async () => {
                    await pullIntoLocalDB(page);
                    const routines = await gtd.listRoutines(page);
                    return routines.find((r) => r._id === routine._id)?.active;
                })
                .toBe(false);

            const items = await gtd.listItems(page);
            const persistedStandalone = items.find((i) => i._id === standaloneItem._id);
            expect(persistedStandalone?.status).toBe('trash');
            const persistedGenerated = items.find((i) => i._id === generatedItem._id);
            expect(persistedGenerated?.status).toBe('trash');
        });
    });
});
