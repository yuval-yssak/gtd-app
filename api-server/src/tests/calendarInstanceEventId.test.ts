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
import { buildCalendarInstanceEventId, normalizeMasterEventId, regenerateFutureRoutineItems } from '../lib/routineItemRegeneration.js';
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

    // ── all-day instance ids ──────────────────────────────────────────────────

    it('emits <masterEventId>_<YYYYMMDD> for an all-day routine (timeOfDay undefined)', () => {
        // GCal returns `<masterId>_<YYYYMMDD>` (no T component) for all-day series instances.
        const date = dayjs.utc('2026-05-19').toDate();
        const id = buildCalendarInstanceEventId(MASTER, date, undefined, 'UTC');
        expect(id).toBe(`${MASTER}_20260519`);
    });

    it("all-day instance id ignores the timeZone argument (date is the calendar owner's local date)", () => {
        // Passing a different TZ must not shift the date — GCal anchors all-day to the owner's local day.
        const date = dayjs.utc('2026-05-19').toDate();
        expect(buildCalendarInstanceEventId(MASTER, date, undefined, 'Pacific/Auckland')).toBe(`${MASTER}_20260519`);
        expect(buildCalendarInstanceEventId(MASTER, date, undefined, 'America/Los_Angeles')).toBe(`${MASTER}_20260519`);
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

    it('all-day routine: generates items with allDay=true and YYYYMMDD-suffixed instance ids', async () => {
        // Phase 8: the regen path now branches on allDay. Items must carry the all-day flag and
        // their instance-id suffix must be date-only (no T component) to match what GCal returns.
        const routine = makeRoutine({ calendarItemTemplate: { allDay: true } });
        await routinesDAO.insertOne(routine);

        await regenerateFutureRoutineItems(routine, USER, dayjs().toISOString(), 'UTC');

        const items = await itemsDAO.findArray({ user: USER, routineId: routine._id });
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            expect(item.allDay).toBe(true);
            // timeStart is YYYY-MM-DD only (no T component)
            expect(item.timeStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            // timeEnd is start + 1 day (GCal exclusive-end convention for single-day all-day)
            expect(item.timeEnd).toBe(dayjs(item.timeStart).add(1, 'day').format('YYYY-MM-DD'));
            // Instance id format: <master>_<YYYYMMDD> with no T component
            const datePart = (item.timeStart ?? '').replace(/-/g, '');
            expect(item.calendarInstanceEventId).toBe(`${MASTER}_${datePart}`);
        }
    });

    it('all-day routine without calendarEventId: items get allDay=true but no instance id', async () => {
        const routine = makeRoutine({ calendarItemTemplate: { allDay: true }, calendarEventId: undefined });
        await routinesDAO.insertOne(routine);

        await regenerateFutureRoutineItems(routine, USER, dayjs().toISOString(), 'UTC');

        const items = await itemsDAO.findArray({ user: USER, routineId: routine._id });
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            expect(item.allDay).toBe(true);
            expect(item.calendarInstanceEventId).toBeUndefined();
        }
    });

    it('skips an occurrence already owned by a sibling routine on the same GCal series, without throwing', async () => {
        // Fix B3 regression: two routines bound to the SAME GCal series generate the same
        // calendarInstanceEventId for the same date. Pre-fix, the second insert hit the
        // (user, calendarInstanceEventId) unique index and the raw E11000 propagated out of the
        // whole webhook sync. Now the colliding occurrence is skipped and the rest still insert.
        const tz = 'UTC';
        const now = dayjs().toISOString();

        // Sibling routine (different _id) already owns tomorrow's instance on the shared master.
        const tomorrow = dayjs().add(1, 'day').utc().startOf('day');
        const tomorrowDatePart = tomorrow.format('YYYYMMDD');
        const sharedInstanceId = `${MASTER}_${tomorrowDatePart}T090000Z`;
        await itemsDAO.insertOne({
            _id: 'sibling-item',
            user: USER,
            status: 'calendar',
            title: 'Sibling-owned occurrence',
            routineId: 'routine-sibling',
            timeStart: `${tomorrow.format('YYYY-MM-DD')}T09:00:00`,
            timeEnd: `${tomorrow.format('YYYY-MM-DD')}T09:30:00`,
            calendarEventId: MASTER,
            calendarInstanceEventId: sharedInstanceId,
            createdTs: now,
            updatedTs: now,
        });

        // Routine-under-test: daily, same master → tomorrow collides, every later date is free.
        const routine = makeRoutine({ _id: 'routine-under-test' });
        await routinesDAO.insertOne(routine);

        // Must not throw despite the guaranteed E11000 on tomorrow's instance.
        const ops = await regenerateFutureRoutineItems(routine, USER, now, tz);

        const ownItems = await itemsDAO.findArray({ user: USER, routineId: routine._id });
        expect(ownItems.length).toBeGreaterThan(0);
        // The colliding date was skipped: none of this routine's items carry the sibling's instance id.
        expect(ownItems.every((i) => i.calendarInstanceEventId !== sharedInstanceId)).toBe(true);
        // Op count matches inserted items (the skipped occurrence produced no op).
        expect(ops.filter((op) => op.opType === 'create').length).toBe(ownItems.length);
        // The sibling's item is untouched.
        const sibling = await itemsDAO.findOne({ _id: 'sibling-item' });
        expect(sibling?.title).toBe('Sibling-owned occurrence');
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

describe('normalizeMasterEventId', () => {
    it('strips the timed recurrence-anchor suffix (_R<YYYYMMDDTHHMMSS>)', () => {
        expect(normalizeMasterEventId('mleem99efhim4a0tsh3s86797o_R20260519T123000')).toBe('mleem99efhim4a0tsh3s86797o');
    });

    it('strips the timed recurrence-anchor suffix with trailing Z (_R<YYYYMMDDTHHMMSS>Z)', () => {
        expect(normalizeMasterEventId('abc123_R20260519T123000Z')).toBe('abc123');
    });

    it('strips the all-day recurrence-anchor suffix (_R<YYYYMMDD>)', () => {
        expect(normalizeMasterEventId('def456_R20260519')).toBe('def456');
    });

    it('is idempotent — bare master ids pass through unchanged', () => {
        expect(normalizeMasterEventId('mleem99efhim4a0tsh3s86797o')).toBe('mleem99efhim4a0tsh3s86797o');
    });

    it('does NOT strip plain instance suffixes (_<UTC>Z) — those are valid instance ids, not master suffixes', () => {
        // Plain `_20260526T123000Z` is a single-instance id, not a rebased master. Stripping it
        // would conflate instances with the master id and break per-instance reconcile.
        expect(normalizeMasterEventId('mleem99efhim4a0tsh3s86797o_20260526T123000Z')).toBe('mleem99efhim4a0tsh3s86797o_20260526T123000Z');
    });

    it('strips only the trailing _R<…> anchor — leaves internal underscores intact', () => {
        // Defensive: master ids can in principle contain underscores; the regex is anchored to end-of-string.
        expect(normalizeMasterEventId('foo_bar_baz_R20260519T123000')).toBe('foo_bar_baz');
    });

    it('passes through an empty string unchanged', () => {
        // Defensive: callers protect against `undefined` via `?? ''`; the helper must not crash on the fallback.
        expect(normalizeMasterEventId('')).toBe('');
    });

    it('does NOT strip an all-day-with-Z form (_R<YYYYMMDD>Z) — current regex only handles the timed-with-Z case', () => {
        // GCal has not been observed to emit this form; if it ever does, the regex would need to widen
        // to `_R\d{8}(T\d{6})?Z?$`. This test pins the current behavior so future changes are intentional.
        expect(normalizeMasterEventId('abc_R20260519Z')).toBe('abc_R20260519Z');
    });
});

describe('routines uniq_active_routine_per_gcal_series index (Fix B1)', () => {
    const now = '2026-01-01T00:00:00.000Z';
    // Base in-app routine: NO calendarEventId/calendarIntegrationId keys at all (mirrors how real
    // in-app routines are stored — the keys are omitted, not set to null). Linked routines add them.
    const baseRoutine = (overrides: Partial<RoutineInterface>): RoutineInterface => ({
        _id: 'r-default',
        user: USER,
        title: 'Standup',
        routineType: 'calendar',
        rrule: 'FREQ=DAILY',
        template: {},
        active: true,
        createdTs: now,
        updatedTs: now,
        calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
        ...overrides,
    });
    const linkedRoutine = (overrides: Partial<RoutineInterface>): RoutineInterface =>
        baseRoutine({ calendarEventId: 'series-x', calendarIntegrationId: 'int-x', ...overrides });

    it('rejects a second ACTIVE routine on the same (user, calendarEventId, integration)', async () => {
        await routinesDAO.insertOne(linkedRoutine({ _id: 'r-1' }));
        await expect(routinesDAO.insertOne(linkedRoutine({ _id: 'r-2' }))).rejects.toMatchObject({ code: 11000 });
    });

    it('allows an INACTIVE duplicate alongside the active one (partial filter on active:true)', async () => {
        await routinesDAO.insertOne(linkedRoutine({ _id: 'r-active' }));
        await expect(routinesDAO.insertOne(linkedRoutine({ _id: 'r-dead', active: false }))).resolves.toBeDefined();
    });

    it('allows two in-app routines with no calendarEventId (constraint guarded by $type:string)', async () => {
        await routinesDAO.insertOne(baseRoutine({ _id: 'r-inapp-1' }));
        await expect(routinesDAO.insertOne(baseRoutine({ _id: 'r-inapp-2' }))).resolves.toBeDefined();
    });

    it('allows multiple in-app routines that store an explicit calendarEventId:null (real staging data shape)', async () => {
        // Regression for an index-build crash: real in-app routines were observed storing
        // calendarEventId:null (not omitted). With $exists:true they would all fold under one index
        // key and collide on build; $type:'string' correctly excludes null-valued routines.
        await routinesDAO.insertOne({ ...baseRoutine({ _id: 'r-null-1' }), calendarEventId: null } as never);
        await expect(routinesDAO.insertOne({ ...baseRoutine({ _id: 'r-null-2' }), calendarEventId: null } as never)).resolves.toBeDefined();
    });
});
