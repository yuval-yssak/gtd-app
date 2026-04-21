import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

import { addUntilToRrule, computeSplitDate, routineHasPastItems, routineHasUpcomingOccurrence, stripEndClauses } from '../lib/routineSplitUtils';
import type { MyDB, StoredItem } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const USER_ID = 'user-1';
const ROUTINE_ID = 'routine-1';

function buildItem(overrides: Partial<StoredItem> = {}): StoredItem {
    return {
        _id: `item-${Math.random().toString(36).slice(2, 8)}`,
        userId: USER_ID,
        status: 'calendar',
        title: 'Routine item',
        createdTs: '2025-01-01T00:00:00.000Z',
        updatedTs: '2025-01-01T00:00:00.000Z',
        routineId: ROUTINE_ID,
        ...overrides,
    };
}

describe('routineHasUpcomingOccurrence', () => {
    it('returns true for an active daily series', () => {
        // createdTs far in the past, daily rule — always has future occurrences
        expect(routineHasUpcomingOccurrence('FREQ=DAILY;INTERVAL=1', '2024-01-01T00:00:00.000Z')).toBe(true);
    });

    it('returns false for an exhausted series (UNTIL in the past)', () => {
        expect(routineHasUpcomingOccurrence('FREQ=DAILY;INTERVAL=1;UNTIL=20240101T235959Z', '2024-01-01T00:00:00.000Z')).toBe(false);
    });

    it('returns false for a COUNT=1 series that already occurred', () => {
        expect(routineHasUpcomingOccurrence('FREQ=DAILY;INTERVAL=1;COUNT=1', '2024-01-01T00:00:00.000Z')).toBe(false);
    });
});

describe('computeSplitDate', () => {
    it('returns the next occurrence date for an active series', () => {
        const result = computeSplitDate('FREQ=DAILY;INTERVAL=1', '2024-01-01T00:00:00.000Z');
        expect(result).not.toBeNull();
        // Should be tomorrow or later (exact date depends on when test runs)
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('returns null for an exhausted series', () => {
        expect(computeSplitDate('FREQ=DAILY;INTERVAL=1;UNTIL=20240101T235959Z', '2024-01-01T00:00:00.000Z')).toBeNull();
    });

    it('returns null for a COUNT=1 series that already occurred', () => {
        expect(computeSplitDate('FREQ=DAILY;INTERVAL=1;COUNT=1', '2024-01-01T00:00:00.000Z')).toBeNull();
    });
});

describe('addUntilToRrule', () => {
    it('appends UNTIL for the day before the given date', () => {
        const result = addUntilToRrule('FREQ=DAILY;INTERVAL=1', '2025-03-15');
        expect(result).toBe('FREQ=DAILY;INTERVAL=1;UNTIL=20250314T235959Z');
    });

    it('strips existing UNTIL before appending', () => {
        const result = addUntilToRrule('FREQ=DAILY;INTERVAL=1;UNTIL=20251231T235959Z', '2025-03-15');
        expect(result).toBe('FREQ=DAILY;INTERVAL=1;UNTIL=20250314T235959Z');
    });

    it('strips existing COUNT before appending UNTIL', () => {
        const result = addUntilToRrule('FREQ=WEEKLY;BYDAY=MO;COUNT=10', '2025-06-01');
        expect(result).toBe('FREQ=WEEKLY;BYDAY=MO;UNTIL=20250531T235959Z');
    });

    it('handles January 1 boundary (day before = Dec 31 of previous year)', () => {
        const result = addUntilToRrule('FREQ=DAILY;INTERVAL=1', '2025-01-01');
        expect(result).toBe('FREQ=DAILY;INTERVAL=1;UNTIL=20241231T235959Z');
    });
});

describe('stripEndClauses', () => {
    it('strips UNTIL from the middle of an rrule', () => {
        expect(stripEndClauses('FREQ=DAILY;UNTIL=20251231T235959Z;INTERVAL=1')).toBe('FREQ=DAILY;INTERVAL=1');
    });

    it('strips COUNT from the end of an rrule', () => {
        expect(stripEndClauses('FREQ=WEEKLY;BYDAY=MO;COUNT=10')).toBe('FREQ=WEEKLY;BYDAY=MO');
    });

    it('strips UNTIL when it appears as the first token', () => {
        expect(stripEndClauses('UNTIL=20251231T235959Z;FREQ=DAILY;INTERVAL=1')).toBe('FREQ=DAILY;INTERVAL=1');
    });

    it('strips COUNT when it appears as the first token', () => {
        expect(stripEndClauses('COUNT=5;FREQ=DAILY')).toBe('FREQ=DAILY');
    });

    it('returns the rrule unchanged when no UNTIL or COUNT is present', () => {
        expect(stripEndClauses('FREQ=DAILY;INTERVAL=1')).toBe('FREQ=DAILY;INTERVAL=1');
    });
});

describe('routineHasPastItems', () => {
    let db: IDBPDatabase<MyDB>;

    beforeEach(async () => {
        db = await openTestDB();
    });

    afterEach(() => {
        db.close();
        vi.clearAllMocks();
    });

    it('returns false when the routine has no calendar items', async () => {
        expect(await routineHasPastItems(db, USER_ID, ROUTINE_ID)).toBe(false);
    });

    it('returns false when all items are today or in the future', async () => {
        await db.put('items', buildItem({ _id: 'today', timeStart: `${dayjs().format('YYYY-MM-DD')}T09:00:00` }));
        await db.put('items', buildItem({ _id: 'future', timeStart: dayjs().add(7, 'day').format('YYYY-MM-DDT09:00:00') }));
        expect(await routineHasPastItems(db, USER_ID, ROUTINE_ID)).toBe(false);
    });

    it('returns true when at least one item has a past timeStart', async () => {
        await db.put('items', buildItem({ _id: 'past', timeStart: dayjs().subtract(3, 'day').format('YYYY-MM-DDT09:00:00') }));
        await db.put('items', buildItem({ _id: 'future', timeStart: dayjs().add(3, 'day').format('YYYY-MM-DDT09:00:00') }));
        expect(await routineHasPastItems(db, USER_ID, ROUTINE_ID)).toBe(true);
    });

    it('ignores past items that belong to a different routine', async () => {
        await db.put('items', buildItem({ _id: 'other', routineId: 'routine-2', timeStart: dayjs().subtract(3, 'day').format('YYYY-MM-DDT09:00:00') }));
        expect(await routineHasPastItems(db, USER_ID, ROUTINE_ID)).toBe(false);
    });

    it('ignores past items that are not calendar items', async () => {
        await db.put('items', buildItem({ _id: 'done-past', status: 'done', timeStart: dayjs().subtract(3, 'day').format('YYYY-MM-DDT09:00:00') }));
        expect(await routineHasPastItems(db, USER_ID, ROUTINE_ID)).toBe(false);
    });

    it('ignores calendar items with a missing timeStart', async () => {
        await db.put('items', buildItem({ _id: 'no-time' }));
        expect(await routineHasPastItems(db, USER_ID, ROUTINE_ID)).toBe(false);
    });
});
