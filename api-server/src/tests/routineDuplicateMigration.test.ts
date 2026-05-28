import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { dedupeActiveRoutinesPerGCalSeries } from '../loaders/routineDuplicateMigration.js';
import type { RoutineInterface } from '../types/entities.js';

const USER = 'user-routine-dedup';
const INDEX_NAME = 'uniq_active_routine_per_gcal_series';

beforeAll(async () => {
    await loadDataAccess('gtd_test_routine_dedup');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await db.collection('routines').deleteMany({});
    // The unique index is built by loadDataAccess; drop it so violating fixtures can be inserted
    // (exactly the boot precondition the migration exists to satisfy). Each test rebuilds it to
    // prove the post-migration data is clean enough for the index to build.
    await db
        .collection('routines')
        .dropIndex(INDEX_NAME)
        .catch(() => undefined);
});

function makeRoutine(overrides: Partial<RoutineInterface> = {}): RoutineInterface {
    const now = '2026-01-01T00:00:00.000Z';
    const routine: RoutineInterface = {
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
        calendarEventId: 'series-1',
        calendarIntegrationId: 'int-1',
        ...overrides,
    };
    // Real in-app routines OMIT these keys rather than storing null. Strip them when a test passes
    // undefined so the fixture matches production shape (the migration keys on $exists, not value).
    if (overrides.calendarEventId === undefined && 'calendarEventId' in overrides) {
        delete routine.calendarEventId;
    }
    if (overrides.calendarIntegrationId === undefined && 'calendarIntegrationId' in overrides) {
        delete routine.calendarIntegrationId;
    }
    return routine;
}

describe('dedupeActiveRoutinesPerGCalSeries', () => {
    it('keeps the most-recently-updated active routine and demotes the rest, leaving the index buildable', async () => {
        await routinesDAO.insertOne(makeRoutine({ _id: 'r-old', updatedTs: '2026-01-01T00:00:00.000Z' }));
        await routinesDAO.insertOne(makeRoutine({ _id: 'r-mid', updatedTs: '2026-02-01T00:00:00.000Z' }));
        await routinesDAO.insertOne(makeRoutine({ _id: 'r-new', updatedTs: '2026-03-01T00:00:00.000Z' }));

        await dedupeActiveRoutinesPerGCalSeries(db);

        const keeper = await routinesDAO.findByOwnerAndId('r-new', USER);
        const old = await routinesDAO.findByOwnerAndId('r-old', USER);
        const mid = await routinesDAO.findByOwnerAndId('r-mid', USER);
        expect(keeper?.active).toBe(true);
        expect(old?.active).toBe(false);
        expect(mid?.active).toBe(false);
        // The demoted rows got their updatedTs bumped so devices reconcile the flip on next pull.
        expect(old?.updatedTs).not.toBe('2026-01-01T00:00:00.000Z');

        // Post-migration data is clean → the unique index now builds without throwing.
        await expect(routinesDAO.ensureUniqueActiveSeriesIndex()).resolves.toBeUndefined();
    });

    it('leaves a single active routine untouched (no false demotion)', async () => {
        await routinesDAO.insertOne(makeRoutine({ _id: 'r-solo' }));

        await dedupeActiveRoutinesPerGCalSeries(db);

        const solo = await routinesDAO.findByOwnerAndId('r-solo', USER);
        expect(solo?.active).toBe(true);
        expect(solo?.updatedTs).toBe('2026-01-01T00:00:00.000Z');
    });

    it('does not collapse routines that differ only by integration or event id', async () => {
        await routinesDAO.insertOne(makeRoutine({ _id: 'r-a', calendarIntegrationId: 'int-1' }));
        await routinesDAO.insertOne(makeRoutine({ _id: 'r-b', calendarIntegrationId: 'int-2' }));
        await routinesDAO.insertOne(makeRoutine({ _id: 'r-c', calendarEventId: 'series-2' }));

        await dedupeActiveRoutinesPerGCalSeries(db);

        for (const id of ['r-a', 'r-b', 'r-c']) {
            const routine = await routinesDAO.findByOwnerAndId(id, USER);
            expect(routine?.active).toBe(true);
        }
    });

    it('ignores inactive routines and in-app routines (no calendarEventId)', async () => {
        await routinesDAO.insertOne(makeRoutine({ _id: 'r-active' }));
        await routinesDAO.insertOne(makeRoutine({ _id: 'r-already-dead', active: false }));
        await routinesDAO.insertOne(makeRoutine({ _id: 'r-inapp-1', calendarEventId: undefined, calendarIntegrationId: undefined }));
        await routinesDAO.insertOne(makeRoutine({ _id: 'r-inapp-2', calendarEventId: undefined, calendarIntegrationId: undefined }));

        await dedupeActiveRoutinesPerGCalSeries(db);

        // The lone active routine on the series stays active; the pre-existing dead one stays dead;
        // in-app routines are never grouped (no calendarEventId).
        expect((await routinesDAO.findByOwnerAndId('r-active', USER))?.active).toBe(true);
        expect((await routinesDAO.findByOwnerAndId('r-inapp-1', USER))?.active).toBe(true);
        expect((await routinesDAO.findByOwnerAndId('r-inapp-2', USER))?.active).toBe(true);
    });

    it('is idempotent — a second run finds no groups and changes nothing', async () => {
        await routinesDAO.insertOne(makeRoutine({ _id: 'r-1', updatedTs: '2026-01-01T00:00:00.000Z' }));
        await routinesDAO.insertOne(makeRoutine({ _id: 'r-2', updatedTs: '2026-02-01T00:00:00.000Z' }));

        await dedupeActiveRoutinesPerGCalSeries(db);
        const afterFirst = await routinesDAO.findByOwnerAndId('r-1', USER);
        await dedupeActiveRoutinesPerGCalSeries(db);
        const afterSecond = await routinesDAO.findByOwnerAndId('r-1', USER);

        expect(afterFirst?.active).toBe(false);
        expect(afterSecond?.updatedTs).toBe(afterFirst?.updatedTs);
        // Exactly one active routine remains on the series.
        const active = await routinesDAO.findArray({ user: USER, calendarEventId: 'series-1', active: true });
        expect(active).toHaveLength(1);
    });
});
