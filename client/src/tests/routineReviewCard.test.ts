import { describe, expect, it } from 'vitest';
import { collapsedOccurrences, occurrenceSummary } from '../components/weeklyReview/RoutineReviewCard';
import type { StoredItem, StoredRoutine } from '../types/MyDB';

// The RoutineReviewCard's pure derivations: which items a collapsed routine entry stands for,
// and the one-line summary under the schedule. Kept out of the renderer so the empty / singular
// / exception edges are pinned without a DOM.

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

describe('occurrenceSummary', () => {
    it('degenerates gracefully to zero occurrences with no next label', () => {
        expect(occurrenceSummary([], undefined)).toBe('0 occurrences on the calendar');
    });

    it('uses the singular for one occurrence and appends the next-occurrence label', () => {
        // Timezone-naive timeStart so describeNextItemDate's local-time formatting is deterministic.
        const only = makeItem({ _id: 'one', routineId: 'r1', timeStart: '2026-09-03T18:00:00' });
        expect(occurrenceSummary([only], only)).toBe('1 occurrence on the calendar · next Thu, Sep 3 18:00');
    });

    it('omits the next label when the series is fully in the past', () => {
        const past = makeItem({ _id: 'past', routineId: 'r1', timeStart: '2026-08-01T18:00:00.000Z' });
        expect(occurrenceSummary([past, past], undefined)).toBe('2 occurrences on the calendar');
    });
});
