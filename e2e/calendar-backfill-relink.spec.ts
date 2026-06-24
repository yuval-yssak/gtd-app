import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { closeContextQuietly, resetServerForEmails } from './helpers/context';
import { loginAs } from './helpers/login';

// Regression for the duplicate-`gtd*`-master bug: on connect/reconnect, the outbound backfill could
// push a brand-new app-owned `gtd*` recurring event for a naked routine that ALREADY has a real
// imported twin on the calendar (the disconnect/reconnect incremental-delta case, where the
// unmodified real master is absent from the sync delta but present on the calendar). The fix matches
// the naked routine against the calendar's full live master list and relinks instead of cloning.
//
// This drives the relink-first path via /dev/calendar/simulate-backfill-relink with a caller-supplied
// `masters` set standing in for provider.listEventsFull (no live Google account needed). End-to-end
// assertion: the seeded naked routine relinks onto the real native event id — no `gtd*` clone minted.

const DEV_SEED_CALENDAR_URL = 'http://localhost:4000/dev/calendar/seed-integration';
const DEV_SEED_ENTITY_URL = 'http://localhost:4000/dev/reassign/seed-entity';
const DEV_SIMULATE_BACKFILL_URL = 'http://localhost:4000/dev/calendar/simulate-backfill-relink';
const DEV_FIND_ENTITY_URL = 'http://localhost:4000/dev/reassign/find-entity';

async function seedNakedRoutine(userId: string, routineId: string): Promise<void> {
    const now = dayjs().toISOString();
    const res = await fetch(DEV_SEED_ENTITY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            collection: 'routines',
            doc: {
                _id: routineId,
                user: userId,
                title: 'Daily standup',
                routineType: 'calendar',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                template: {},
                active: true,
                calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
                createdTs: now,
                updatedTs: now,
            },
        }),
    });
    if (!res.ok) {
        throw new Error(`seed-entity ${res.status}: ${await res.text()}`);
    }
}

async function simulateBackfillRelink(body: {
    userId: string;
    integrationId: string;
    syncConfigId: string;
    masters: Array<Record<string, unknown>>;
}): Promise<{ relinked: number; wouldCreate: number }> {
    const res = await fetch(DEV_SIMULATE_BACKFILL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        throw new Error(`simulate-backfill-relink ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as { relinked: number; wouldCreate: number };
}

async function findRoutine(routineId: string): Promise<{ calendarEventId?: string } | null> {
    const res = await fetch(`${DEV_FIND_ENTITY_URL}?collection=routines&entityId=${routineId}`);
    if (!res.ok) {
        throw new Error(`find-entity ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as { doc: { calendarEventId?: string } | null };
    return body.doc;
}

test.describe('calendar — idempotent backfill relink', () => {
    test('a naked routine relinks onto its real GCal master instead of minting a gtd* clone', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const email = `backfill-relink-${stamp}@example.com`;
        const cfgId = `cfg-relink-${stamp}`;
        const routineId = `routine-relink-${stamp}`;
        await resetServerForEmails([email]);

        const ctx = await browser.newContext();
        try {
            const page = await loginAs(ctx, email);
            const userId = await page.evaluate(async () => {
                const dbReq = indexedDB.open('gtd-app');
                const db = await new Promise<IDBDatabase>((resolve, reject) => {
                    dbReq.onsuccess = () => resolve(dbReq.result);
                    dbReq.onerror = () => reject(dbReq.error);
                });
                return new Promise<string>((resolve) => {
                    const req = db.transaction('activeAccount').objectStore('activeAccount').get('active');
                    req.onsuccess = () => resolve((req.result as { userId: string }).userId);
                });
            });

            const seed = (await (
                await fetch(DEV_SEED_CALENDAR_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId, calendars: [{ configId: cfgId, calendarId: 'primary', displayName: 'Primary', isDefault: true }] }),
                })
            ).json()) as { integrationId: string };

            await seedNakedRoutine(userId, routineId);

            // The real master with a NATIVE Google id (not `gtd*`), matching the naked routine's
            // title + rrule + 09:00/30-min template. seed-integration has no timeZone, so the matcher
            // falls back to UTC — supply a UTC start at 09:00 to match `calendarItemTemplate.timeOfDay`.
            const master = {
                id: 'real-native-gcal-id',
                title: 'Daily standup',
                timeStart: '2025-06-09T09:00:00Z',
                timeEnd: '2025-06-09T09:30:00Z',
                updated: '2025-06-09T08:00:00.000Z',
                status: 'confirmed',
                recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
            };

            const result = await simulateBackfillRelink({ userId, integrationId: seed.integrationId, syncConfigId: cfgId, masters: [master] });
            expect(result.relinked).toBe(1);
            expect(result.wouldCreate).toBe(0);

            // Server-side: the routine now points at the REAL native id — no `gtd*` clone was minted.
            const routine = await findRoutine(routineId);
            expect(routine?.calendarEventId).toBe('real-native-gcal-id');
            expect(routine?.calendarEventId?.startsWith('gtd')).toBe(false);
        } finally {
            await closeContextQuietly(ctx);
        }
    });
});
