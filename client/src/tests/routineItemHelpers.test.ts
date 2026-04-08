import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNextRoutineItem, getCalendarCompletionTiming } from '../db/routineItemHelpers';
import type { MyDB, StoredRoutine } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const USER_ID = 'user-1';

function buildRoutine(overrides: Partial<StoredRoutine> = {}): StoredRoutine {
    return {
        _id: 'routine-1',
        userId: USER_ID,
        title: 'Test routine',
        routineType: 'nextAction',
        rrule: 'FREQ=DAILY;INTERVAL=1',
        template: {},
        active: true,
        createdTs: '2025-01-01T00:00:00.000Z',
        updatedTs: '2025-01-01T00:00:00.000Z',
        ...overrides,
    };
}

// ── createNextRoutineItem ─────────────────────────────────────────────────────

describe('createNextRoutineItem', () => {
    let db: IDBPDatabase<MyDB>;

    beforeEach(async () => {
        db = await openTestDB();
    });

    afterEach(() => {
        db.close();
    });

    it('sets ignoreBefore equal to expectedBy (tickler until due date)', async () => {
        const routine = buildRoutine();
        await createNextRoutineItem(db, USER_ID, routine, new Date('2025-06-01'));

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        expect(items).toHaveLength(1);
        const generated = items[0]!;
        expect(generated.ignoreBefore).toBe(generated.expectedBy);
        expect(generated.routineId).toBe('routine-1');
        expect(generated.status).toBe('nextAction');
    });

    it('computes expectedBy from rrule and completion date', async () => {
        // Every 3 days — completing on June 1 should yield June 4
        const routine = buildRoutine({ rrule: 'FREQ=DAILY;INTERVAL=3' });
        await createNextRoutineItem(db, USER_ID, routine, new Date('2025-06-01'));

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        expect(items[0]!.expectedBy).toBe('2025-06-04');
        expect(items[0]!.ignoreBefore).toBe('2025-06-04');
    });

    it('copies template fields onto the generated item', async () => {
        const routine = buildRoutine({
            template: {
                workContextIds: ['ctx-1'],
                energy: 'high',
                time: 30,
                focus: true,
                urgent: true,
                notes: 'Test notes',
            },
        });
        await createNextRoutineItem(db, USER_ID, routine, new Date('2025-06-01'));

        const items = await db.getAllFromIndex('items', 'userId', USER_ID);
        const generated = items[0]!;
        expect(generated.workContextIds).toEqual(['ctx-1']);
        expect(generated.energy).toBe('high');
        expect(generated.time).toBe(30);
        expect(generated.focus).toBe(true);
        expect(generated.urgent).toBe(true);
        expect(generated.notes).toBe('Test notes');
    });

    it('queues a sync operation for the created item', async () => {
        const routine = buildRoutine();
        await createNextRoutineItem(db, USER_ID, routine, new Date('2025-06-01'));

        const ops = await db.getAll('syncOperations');
        expect(ops).toHaveLength(1);
        expect(ops[0]!.opType).toBe('create');
        expect(ops[0]!.entityType).toBe('item');
    });
});

// ── getCalendarCompletionTiming ───────────────────────────────────────────────

describe('getCalendarCompletionTiming', () => {
    it('returns onTime when completion is within 24h of timeStart', () => {
        const timeStart = '2024-03-14T18:00:00';
        // Completed 2h after start — well within the 24h window
        const completionDate = new Date('2024-03-14T20:00:00Z');
        expect(getCalendarCompletionTiming(timeStart, completionDate)).toBe('onTime');
    });

    it('returns late when completion is more than 24h after timeStart', () => {
        const timeStart = '2024-03-14T18:00:00';
        // 48h after start — well past the 24h window
        const completionDate = new Date('2024-03-16T18:00:00Z');
        expect(getCalendarCompletionTiming(timeStart, completionDate)).toBe('late');
    });

    it('returns onTime when completed exactly 24h after timeStart (boundary — isAfter is strict)', () => {
        // The implementation uses dayjs.isAfter which is strictly greater than.
        // Both sides use dayjs local time so the comparison is timezone-independent.
        const timeStart = '2024-03-14T12:00:00';
        // Exactly 24h later in local time — NOT after the boundary, so must be 'onTime'
        const completionDate = dayjs('2024-03-14T12:00:00').add(24, 'hour').toDate();
        expect(getCalendarCompletionTiming(timeStart, completionDate)).toBe('onTime');
    });

    it('returns onTime when completed before timeStart (trashed before due)', () => {
        const timeStart = '2024-03-20T10:00:00';
        // Completed a week before the event
        const completionDate = new Date('2024-03-13T10:00:00Z');
        expect(getCalendarCompletionTiming(timeStart, completionDate)).toBe('onTime');
    });
});
