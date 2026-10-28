import { describe, expect, it } from 'vitest';
import { collapsedOccurrences, remainingOccurrencesLabel, reviewedOccurrence, sortAnchorOccurrence } from '../components/weeklyReview/routineReviewCardLogic';
import type { StoredItem, StoredRoutine } from '../types/MyDB';

// The RoutineReviewCard's pure derivations: which items a collapsed routine entry stands for, and
// which one of them the card's embedded editor shows and completes. Kept out of the renderer so the
// empty / singular / exception edges are pinned without a DOM.

function makeItem(overrides: Partial<StoredItem> & { _id: string }): StoredItem {
    return {
        userId: 'user-1',
        title: overrides._id,
        status: 'calendar',
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

function makeRoutine(overrides: Partial<StoredRoutine> & { _id: string }): StoredRoutine {
    return {
        userId: 'user-1',
        title: overrides._id,
        routineType: 'calendar',
        rrule: 'FREQ=WEEKLY;BYDAY=TH',
        template: {},
        active: true,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

describe('collapsedOccurrences', () => {
    it('keeps only the routine own calendar items, sorted by timeStart, excluding modified exceptions', () => {
        const routine = makeRoutine({ _id: 'r1', routineExceptions: [{ date: '2026-09-03', type: 'modified', itemId: 'exc' }] });
        const items = [
            makeItem({ _id: 'later', routineId: 'r1', timeStart: '2026-09-10T18:00:00.000Z' }),
            makeItem({ _id: 'sooner', routineId: 'r1', timeStart: '2026-08-27T18:00:00.000Z' }),
            makeItem({ _id: 'exc', routineId: 'r1', timeStart: '2026-09-03T18:00:00.000Z' }),
            makeItem({ _id: 'foreign', routineId: 'r2', timeStart: '2026-09-01T18:00:00.000Z' }),
            makeItem({ _id: 'doneOne', routineId: 'r1', status: 'done', timeStart: '2026-08-20T18:00:00.000Z' }),
        ];
        expect(collapsedOccurrences(routine, items).map((item) => item._id)).toEqual(['sooner', 'later']);
    });
});

describe('sortAnchorOccurrence', () => {
    it('picks the earliest dated occurrence — the one the calendar stage ranked the entry by', () => {
        const occurrences = [makeItem({ _id: 'first', timeStart: '2026-09-06T12:00:00' }), makeItem({ _id: 'second', timeStart: '2026-11-15T12:00:00' })];
        expect(sortAnchorOccurrence(occurrences)?._id).toBe('first');
    });

    it('skips undated occurrences so the headline never falls back to a date-less item', () => {
        const occurrences = [makeItem({ _id: 'undated' }), makeItem({ _id: 'dated', timeStart: '2026-09-06T12:00:00' })];
        expect(sortAnchorOccurrence(occurrences)?._id).toBe('dated');
    });

    it('returns undefined for a series with nothing generated yet', () => {
        expect(sortAnchorOccurrence([])).toBeUndefined();
    });
});

describe('reviewedOccurrence', () => {
    const routine = makeRoutine({ _id: 'r1' });
    const first = makeItem({ _id: 'first', routineId: 'r1', timeStart: '2026-10-28T09:45:00', timeEnd: '2026-10-28T10:00:00' });
    const second = makeItem({ _id: 'second', routineId: 'r1', timeStart: '2026-10-29T09:45:00', timeEnd: '2026-10-29T10:00:00' });

    it('is the FIRST undone occurrence — overdue included — never the next upcoming one', () => {
        // The reported bug: the card led with today's ended meeting while Done completed tomorrow's.
        expect(reviewedOccurrence(routine, [second, first], undefined)?._id).toBe('first');
    });

    it('stays on the pinned occurrence after an edit turned it into a modified exception', () => {
        const moved = { ...first, timeStart: '2026-10-30T11:00:00', timeEnd: '2026-10-30T11:15:00' };
        const withException = makeRoutine({ _id: 'r1', routineExceptions: [{ date: '2026-10-28', type: 'modified', itemId: 'first' }] });
        expect(reviewedOccurrence(withException, [moved, second], 'first')?._id).toBe('first');
    });

    it('falls back to the first undone occurrence once the pinned one is done', () => {
        expect(reviewedOccurrence(routine, [{ ...first, status: 'done' }, second], 'first')?._id).toBe('second');
    });

    it('ignores a pin that names another routine occurrence', () => {
        const foreign = makeItem({ _id: 'foreign', routineId: 'r2', timeStart: '2026-10-27T09:00:00' });
        expect(reviewedOccurrence(routine, [foreign, first], 'foreign')?._id).toBe('first');
    });

    it('is undefined for a series with nothing generated yet', () => {
        expect(reviewedOccurrence(routine, [], undefined)).toBeUndefined();
    });
});

describe('remainingOccurrencesLabel', () => {
    const a = makeItem({ _id: 'a', timeStart: '2026-09-03T18:00:00' });
    const b = makeItem({ _id: 'b', timeStart: '2026-09-10T18:00:00' });
    const c = makeItem({ _id: 'c', timeStart: '2026-09-17T18:00:00' });

    it('is empty when the shown occurrence is the only one', () => {
        expect(remainingOccurrencesLabel([a], a)).toBe('');
    });

    it('counts the occurrences after the shown one', () => {
        expect(remainingOccurrencesLabel([a, b, c], a)).toBe('2 more after this one');
    });

    it('still counts right once the shown occurrence became an exception and left the collapsed list', () => {
        expect(remainingOccurrencesLabel([b, c], a)).toBe('2 more after this one');
    });

    it('is empty for a series with nothing generated yet', () => {
        expect(remainingOccurrencesLabel([], undefined)).toBe('');
    });
});
