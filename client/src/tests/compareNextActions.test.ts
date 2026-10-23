import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { compareNextActions, expectedDayKey } from '../lib/compareNextActions';
import type { StoredItem } from '../types/MyDB';

function makeItem(overrides: Partial<StoredItem> & { _id: string }): StoredItem {
    return {
        userId: 'user-1',
        status: 'nextAction',
        title: overrides._id,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

const sortedIds = (items: StoredItem[]) => [...items].sort(compareNextActions).map((item) => item._id);

// The comparator is a shared contract between the Next Actions page and the weekly-review
// wizard — both must present the exact same order, so its tie semantics are load-bearing.
describe('compareNextActions', () => {
    it('is a total order: equal ranks and same-ms createdTs are broken by _id, so the result never depends on input order', () => {
        const a = makeItem({ _id: 'a', rank: 'a0' });
        const b = makeItem({ _id: 'b', rank: 'a0' });
        expect(compareNextActions(a, b)).toBe(-1);
        expect(sortedIds([b, a])).toEqual(['a', 'b']);
        const unrankedX = makeItem({ _id: 'x' });
        const unrankedY = makeItem({ _id: 'y' });
        expect(sortedIds([unrankedY, unrankedX])).toEqual(['x', 'y']);
    });

    it('treats an empty-string expectedBy as undated', () => {
        const empty = makeItem({ _id: 'empty', expectedBy: '' });
        const dated = makeItem({ _id: 'dated', expectedBy: '2026-09-01' });
        expect(sortedIds([empty, dated])).toEqual(['dated', 'empty']);
    });

    it('orders by expected day ascending with undated last, regardless of rank', () => {
        const later = makeItem({ _id: 'later', expectedBy: '2026-09-02', rank: 'a0' });
        const sooner = makeItem({ _id: 'sooner', expectedBy: '2026-09-01', rank: 'a1' });
        const undated = makeItem({ _id: 'undated', rank: 'Zz' });
        expect(sortedIds([undated, later, sooner])).toEqual(['sooner', 'later', 'undated']);
    });

    it('collapses YYYY-MM-DD and datetime expectedBy values (local wall clock, UTC instant, offset form) to one local day', () => {
        // Every datetime is built from local noon so the expectation holds in any test-runner TZ.
        const localNoon = dayjs('2026-09-01T12:00:00');
        const dateOnly = makeItem({ _id: 'dateOnly', expectedBy: '2026-09-01', rank: 'a1' });
        const wallClock = makeItem({ _id: 'wallClock', expectedBy: '2026-09-01T12:00:00', rank: 'a0' });
        const utcInstant = makeItem({ _id: 'utcInstant', expectedBy: localNoon.toISOString(), rank: 'a2' });
        const offsetForm = makeItem({ _id: 'offsetForm', expectedBy: localNoon.format('YYYY-MM-DDTHH:mm:ssZ'), rank: 'a3' });
        expect(new Set([dateOnly, wallClock, utcInstant, offsetForm].map(expectedDayKey)).size).toBe(1);
        // Same day → rank decides, not the time of day.
        expect(sortedIds([offsetForm, dateOnly, utcInstant, wallClock])).toEqual(['wallClock', 'dateOnly', 'utcInstant', 'offsetForm']);
    });

    it('inside a day, unranked items come first, newest createdTs first, then ranked items by rank', () => {
        const ranked = makeItem({ _id: 'ranked', rank: 'Zz' });
        const freshOld = makeItem({ _id: 'freshOld', createdTs: '2026-02-01T00:00:00.000Z' });
        const freshNew = makeItem({ _id: 'freshNew', createdTs: '2026-03-01T00:00:00.000Z' });
        expect(sortedIds([ranked, freshOld, freshNew])).toEqual(['freshNew', 'freshOld', 'ranked']);
    });

    it('compares ranks by code unit, never by locale: Zz sorts before a0', () => {
        const upper = makeItem({ _id: 'upper', rank: 'Zz' });
        const lower = makeItem({ _id: 'lower', rank: 'a0' });
        expect(sortedIds([lower, upper])).toEqual(['upper', 'lower']);
        expect(['a0', 'Zz'].sort((a, b) => a.localeCompare(b))).toEqual(['a0', 'Zz']);
    });

    it('same-ms unranked items are ordered by _id', () => {
        const x = makeItem({ _id: 'x', createdTs: '2026-02-01T00:00:00.000Z' });
        const y = makeItem({ _id: 'y', createdTs: '2026-02-01T00:00:00.000Z' });
        expect(sortedIds([y, x])).toEqual(['x', 'y']);
    });
});

describe('expectedDayKey', () => {
    it('passes a date-only string through and returns null when undated', () => {
        expect(expectedDayKey({ expectedBy: '2026-09-01' })).toBe('2026-09-01');
        expect(expectedDayKey({})).toBeNull();
        expect(expectedDayKey({ expectedBy: '' })).toBeNull();
    });
});
