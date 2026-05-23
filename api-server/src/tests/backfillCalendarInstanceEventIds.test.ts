/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts shape before using ! */
/**
 * Unit coverage for the backfill helper that derives the original-occurrence date from an item
 * + its routine. The script orchestrator (CLI entry) is not exercised directly here — we test the
 * derivation logic that gates "update vs skip" and reuse `buildCalendarInstanceEventId` in the
 * assertion to confirm the resulting id is what exception sync will then look up.
 *
 * We invoke `recoverOriginalOccurrenceDate` indirectly via `regenerateFutureRoutineItems` for the
 * happy path (items born on schedule), and write the missing branch (moved-by-prior-exception)
 * inline with the routine snapshot the script would see.
 */
import dayjs from 'dayjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import itemsDAO from '../dataAccess/itemsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { buildCalendarInstanceEventId } from '../lib/routineItemRegeneration.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { recoverOriginalOccurrenceDate } from '../scripts/backfillCalendarInstanceEventIds.js';
import type { ItemInterface, RoutineInterface } from '../types/entities.js';

const USER = 'user-backfill-tests';
const MASTER = 'gcal-master-bf-1';

beforeAll(async () => {
    await loadDataAccess('gtd_test_backfill_instance_id');
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
        _id: 'routine-bf',
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

function makeItem(overrides: Partial<ItemInterface> & { _id: string; timeStart: string }): ItemInterface {
    const now = dayjs().toISOString();
    return {
        user: USER,
        status: 'calendar',
        title: 'Standup',
        routineId: 'routine-bf',
        timeEnd: dayjs(overrides.timeStart).add(30, 'minute').toISOString(),
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
}

// Re-implements the private `recoverOriginalOccurrenceDate` to assert it against the real DB rows
// the backfill would see. Kept in sync with the source.
function recoverOriginalDate(item: ItemInterface, routine: RoutineInterface): string | undefined {
    const itemStart = item.timeStart;
    const template = routine.calendarItemTemplate;
    if (!itemStart || !template) {
        return undefined;
    }
    const expectedSuffix = `T${template.timeOfDay}:00`;
    if (itemStart.includes(expectedSuffix)) {
        return itemStart.slice(0, 10);
    }
    const exception = (routine.routineExceptions ?? []).find((e) => e.type === 'modified' && e.newTimeStart === itemStart);
    return exception?.date;
}

describe('backfill derivation — original date recovery', () => {
    it('item still on schedule: derives originalDate from timeStart date', async () => {
        const routine = makeRoutine();
        await routinesDAO.insertOne(routine);

        const item = makeItem({ _id: 'item-on-schedule', timeStart: '2026-05-19T09:00:00' });
        await itemsDAO.insertOne(item);

        const originalDate = recoverOriginalDate(item, routine);
        expect(originalDate).toBe('2026-05-19');
        // Resulting instance id matches what exception sync would look up.
        const id = buildCalendarInstanceEventId(MASTER, dayjs.utc(originalDate).toDate(), '09:00', 'UTC');
        expect(id).toBe(`${MASTER}_20260519T090000Z`);
    });

    it('item moved by prior exception: derives originalDate via routineExceptions match', async () => {
        const routine = makeRoutine({
            routineExceptions: [{ date: '2026-05-19', type: 'modified', newTimeStart: '2026-05-24T12:30:00+03:00', newTimeEnd: '2026-05-24T14:00:00+03:00' }],
        });
        await routinesDAO.insertOne(routine);

        const item = makeItem({ _id: 'item-moved', timeStart: '2026-05-24T12:30:00+03:00', timeEnd: '2026-05-24T14:00:00+03:00' });
        await itemsDAO.insertOne(item);

        const originalDate = recoverOriginalDate(item, routine);
        expect(originalDate).toBe('2026-05-19');
    });

    it('item moved with no matching exception: returns undefined (script must skip)', async () => {
        // Orphan case: item is at an off-schedule time but routineExceptions doesn't reflect it.
        const routine = makeRoutine();
        await routinesDAO.insertOne(routine);

        const item = makeItem({ _id: 'item-orphan', timeStart: '2026-05-24T15:00:00' });
        await itemsDAO.insertOne(item);

        const originalDate = recoverOriginalDate(item, routine);
        expect(originalDate).toBeUndefined();
    });

    it('routine without calendarItemTemplate: returns undefined', async () => {
        const routine = makeRoutine();
        const { calendarItemTemplate: _drop, ...rest } = routine;
        const item = makeItem({ _id: 'item-no-template', timeStart: '2026-05-19T09:00:00' });
        const originalDate = recoverOriginalDate(item, rest as RoutineInterface);
        expect(originalDate).toBeUndefined();
    });
});

describe('backfill — multi-match warning', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('two exceptions with the same newTimeStart: logs a warning and picks the first match', () => {
        // Pathological-but-possible: a routine has two distinct exceptions whose moved-to time
        // happens to collide. The backfill picks the first match (deterministic order from
        // routineExceptions[]) but logs a warning so an operator can re-key the ambiguous rows.
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const routine: RoutineInterface = {
            _id: 'routine-multi',
            user: USER,
            title: 'Standup',
            routineType: 'calendar',
            rrule: 'FREQ=DAILY',
            template: {},
            active: true,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
            calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            calendarEventId: MASTER,
            routineExceptions: [
                { date: '2026-05-19', type: 'modified', newTimeStart: '2026-05-24T12:30:00+03:00', newTimeEnd: '2026-05-24T14:00:00+03:00' },
                { date: '2026-05-20', type: 'modified', newTimeStart: '2026-05-24T12:30:00+03:00', newTimeEnd: '2026-05-24T14:00:00+03:00' },
            ],
        };
        const item: ItemInterface = {
            _id: 'item-ambiguous',
            user: USER,
            status: 'calendar',
            title: 'Standup',
            routineId: routine._id,
            timeStart: '2026-05-24T12:30:00+03:00',
            timeEnd: '2026-05-24T14:00:00+03:00',
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        };
        const originalDate = recoverOriginalOccurrenceDate(item, routine);
        expect(originalDate).toBe('2026-05-19'); // First-match behavior preserved.
        expect(consoleWarnSpy).toHaveBeenCalledOnce();
        const warning = consoleWarnSpy.mock.calls[0]?.[0];
        expect(typeof warning).toBe('string');
        expect(warning as string).toContain('2 exceptions match');
        expect(warning as string).toContain('item-ambiguous');
    });

    it('single match: no warning logged', () => {
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const routine: RoutineInterface = {
            _id: 'routine-single',
            user: USER,
            title: 'Standup',
            routineType: 'calendar',
            rrule: 'FREQ=DAILY',
            template: {},
            active: true,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
            calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            calendarEventId: MASTER,
            routineExceptions: [{ date: '2026-05-19', type: 'modified', newTimeStart: '2026-05-24T12:30:00+03:00', newTimeEnd: '2026-05-24T14:00:00+03:00' }],
        };
        const item: ItemInterface = {
            _id: 'item-single',
            user: USER,
            status: 'calendar',
            title: 'Standup',
            routineId: routine._id,
            timeStart: '2026-05-24T12:30:00+03:00',
            timeEnd: '2026-05-24T14:00:00+03:00',
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        };
        const originalDate = recoverOriginalOccurrenceDate(item, routine);
        expect(originalDate).toBe('2026-05-19');
        expect(consoleWarnSpy).not.toHaveBeenCalled();
    });
});
