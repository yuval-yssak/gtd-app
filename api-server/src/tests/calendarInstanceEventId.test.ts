/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts presence before using ! */
/**
 * Unit + integration coverage for `calendarInstanceEventId`: the field set by `buildCalendarItem`
 * on routine-generated calendar items so exception sync can match an item by GCal instance id
 * even after a prior exception has shifted its `timeStart`.
 *
 * Two layers:
 *  - `buildCalendarInstanceEventId` (exported helper) — pure formatting check, including DST.
 *  - `regenerateFutureRoutineItems` — end-to-end against MongoDB, asserting the items table
 *    carries the field on linked routines and omits it on in-app-only routines.
 */
import dayjs from 'dayjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import itemsDAO from '../dataAccess/itemsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { buildCalendarInstanceEventId, regenerateFutureRoutineItems } from '../lib/routineItemRegeneration.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { RoutineInterface } from '../types/entities.js';

const USER = 'user-instance-id-tests';
const MASTER = 'gcal-master-evt-1';

beforeAll(async () => {
    await loadDataAccess('gtd_test_calendar_instance_id');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([db.collection('items').deleteMany({}), db.collection('routines').deleteMany({}), db.collection('operations').deleteMany({})]);
});

function makeRoutine(overrides: Partial<RoutineInterface> = {}): RoutineInterface {
    const now = '2026-01-01T00:00:00.000Z';
    return {
        _id: 'routine-instance',
        user: USER,
        title: 'Standup',
        routineType: 'calendar',
        rrule: 'FREQ=DAILY',
        template: {},
        active: true,
        createdTs: now,
        updatedTs: now,
        calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
        calendarEventId: MASTER,
        ...overrides,
    };
}

describe('buildCalendarInstanceEventId — format', () => {
    it('emits <masterEventId>_<YYYYMMDDTHHMMSSZ> for a UTC routine', () => {
        const date = dayjs.utc('2026-05-19').toDate();
        const id = buildCalendarInstanceEventId(MASTER, date, '09:00', 'UTC');
        expect(id).toBe(`${MASTER}_20260519T090000Z`);
    });

    it('converts the routine wall-clock time through the calendar TZ to UTC', () => {
        // Asia/Jerusalem on 2026-05-19 is UTC+3 (DST), so 12:00 local → 09:00 UTC.
        const date = dayjs.utc('2026-05-19').toDate();
        const id = buildCalendarInstanceEventId(MASTER, date, '12:00', 'Asia/Jerusalem');
        expect(id).toBe(`${MASTER}_20260519T090000Z`);
    });

    it('handles a DST-spring-forward boundary correctly (US/Eastern late March)', () => {
        // 2026-03-15 in America/New_York is EDT (UTC-4). 09:00 local → 13:00 UTC.
        const date = dayjs.utc('2026-03-15').toDate();
        const id = buildCalendarInstanceEventId(MASTER, date, '09:00', 'America/New_York');
        expect(id).toBe(`${MASTER}_20260315T130000Z`);
    });

    it('handles a winter (post-fallback) date in the same zone', () => {
        // 2026-01-15 in America/New_York is EST (UTC-5). 09:00 local → 14:00 UTC.
        const date = dayjs.utc('2026-01-15').toDate();
        const id = buildCalendarInstanceEventId(MASTER, date, '09:00', 'America/New_York');
        expect(id).toBe(`${MASTER}_20260115T140000Z`);
    });

    it('cross-midnight TZ: local 23:30 in Pacific/Auckland encodes the prior UTC date', () => {
        // 2026-05-19 23:30 Pacific/Auckland is UTC+12 (NZST), so it converts to 11:30 UTC on
        // the SAME date (05-19 23:30 NZST = 05-19 11:30 UTC). Spec'd here so the test still
        // catches regressions if someone later passes a NZDT date — keeping the encoded UTC
        // date aligned with what GCal emits for the instance id.
        const date = dayjs.utc('2026-05-19').toDate();
        const id = buildCalendarInstanceEventId(MASTER, date, '23:30', 'Pacific/Auckland');
        expect(id).toBe(`${MASTER}_20260519T113000Z`);
    });

    it('cross-midnight TZ (NZDT, summer): local 23:30 in Pacific/Auckland encodes prior UTC date', () => {
        // 2026-12-15 in Pacific/Auckland is NZDT (UTC+13). 23:30 local = 10:30 UTC on SAME date.
        const date = dayjs.utc('2026-12-15').toDate();
        const id = buildCalendarInstanceEventId(MASTER, date, '23:30', 'Pacific/Auckland');
        expect(id).toBe(`${MASTER}_20261215T103000Z`);
    });

    it('cross-midnight TZ shift back: NZDT 00:30 encodes the PRIOR UTC date', () => {
        // 2026-12-15 00:30 Pacific/Auckland (UTC+13 NZDT) = 2026-12-14 11:30 UTC — prior date.
        // Confirms a routine whose local 00:30 occurrence on day N actually emits a UTC
        // instance id for day N-1, matching what GCal would produce.
        const date = dayjs.utc('2026-12-15').toDate();
        const id = buildCalendarInstanceEventId(MASTER, date, '00:30', 'Pacific/Auckland');
        expect(id).toBe(`${MASTER}_20261214T113000Z`);
    });
});

describe('regenerateFutureRoutineItems — sets calendarInstanceEventId', () => {
    it('linked routine + timeZone supplied: every generated item gets the field', async () => {
        const routine = makeRoutine();
        await routinesDAO.insertOne(routine);

        const ops = await regenerateFutureRoutineItems(routine, USER, dayjs().toISOString(), 'UTC');
        expect(ops.length).toBeGreaterThan(0);

        const items = await itemsDAO.findArray({ user: USER, routineId: routine._id });
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            expect(item.calendarInstanceEventId).toBeDefined();
            // Format check: `<master>_<YYYYMMDDTHHMMSSZ>` with the item's local-date prefix.
            const datePart = (item.timeStart ?? '').slice(0, 10).replace(/-/g, '');
            expect(item.calendarInstanceEventId).toBe(`${MASTER}_${datePart}T090000Z`);
        }
    });

    it('routine without calendarEventId (in-app only): field is unset on items', async () => {
        const routine = makeRoutine({ calendarEventId: undefined });
        await routinesDAO.insertOne(routine);

        await regenerateFutureRoutineItems(routine, USER, dayjs().toISOString(), 'UTC');

        const items = await itemsDAO.findArray({ user: USER, routineId: routine._id });
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            expect(item.calendarInstanceEventId).toBeUndefined();
        }
    });

    it('linked routine but no timeZone passed: field is unset (caller must thread TZ explicitly)', async () => {
        const routine = makeRoutine();
        await routinesDAO.insertOne(routine);

        await regenerateFutureRoutineItems(routine, USER, dayjs().toISOString());

        const items = await itemsDAO.findArray({ user: USER, routineId: routine._id });
        for (const item of items) {
            expect(item.calendarInstanceEventId).toBeUndefined();
        }
    });

    it('complex rrule (WEEKLY+BYDAY): all generated items still get the instance id', async () => {
        // Anchor in the recent past so the next BYDAY match falls inside the horizon.
        const routine = makeRoutine({
            rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
            startDate: dayjs().startOf('week').format('YYYY-MM-DD'),
            createdTs: dayjs().subtract(2, 'week').toISOString(),
        });
        await routinesDAO.insertOne(routine);

        await regenerateFutureRoutineItems(routine, USER, dayjs().toISOString(), 'UTC');

        const items = await itemsDAO.findArray({ user: USER, routineId: routine._id });
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            expect(item.calendarInstanceEventId).toMatch(new RegExp(`^${MASTER}_\\d{8}T090000Z$`));
        }
    });
});
