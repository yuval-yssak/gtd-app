import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import {
    collapsedOccurrences,
    needsOverdueChoice,
    nextOverdueOccurrence,
    overdueDatesLabel,
    overdueOccurrences,
    planOverdueDisposal,
    remainingOccurrencesLabel,
    resolveOverdueChoice,
    reviewedOccurrence,
    revisitedOccurrence,
    sortAnchorOccurrence,
} from '../components/weeklyReview/routineReviewCardLogic';
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

// The revisit view of a decided routine entry reopens the editor on the occurrence the decision
// was made over — completed or not — so the card looks like it did before the decision.
describe('revisitedOccurrence', () => {
    const routine = makeRoutine({ _id: 'r1' });

    it('returns the recorded occurrence even after the decision completed it', () => {
        const done = makeItem({ _id: 'done', routineId: 'r1', status: 'done', timeStart: '2026-08-27T18:00:00.000Z' });
        const open = makeItem({ _id: 'open', routineId: 'r1', timeStart: '2026-09-03T18:00:00.000Z' });
        expect(revisitedOccurrence(routine, [open, done], 'done')).toBe(done);
    });

    it('falls back to the first open occurrence when the decision recorded none (older drafts)', () => {
        const open = makeItem({ _id: 'open', routineId: 'r1', timeStart: '2026-09-03T18:00:00.000Z' });
        expect(revisitedOccurrence(routine, [open], undefined)).toBe(open);
    });

    it('ignores a recorded id that is no longer this routine’s row', () => {
        const foreign = makeItem({ _id: 'foreign', routineId: 'other' });
        const open = makeItem({ _id: 'open', routineId: 'r1', timeStart: '2026-09-03T18:00:00.000Z' });
        expect(revisitedOccurrence(routine, [foreign, open], 'foreign')).toBe(open);
        expect(revisitedOccurrence(routine, [], 'gone')).toBeUndefined();
    });
});

describe('remainingOccurrencesLabel', () => {
    const now = dayjs('2026-09-01T12:00:00');
    const a = makeItem({ _id: 'a', timeStart: '2026-09-03T18:00:00' });
    const b = makeItem({ _id: 'b', timeStart: '2026-09-10T18:00:00' });
    const c = makeItem({ _id: 'c', timeStart: '2026-09-17T18:00:00' });
    const pastA = makeItem({ _id: 'pastA', timeStart: '2026-08-18T18:00:00', timeEnd: '2026-08-18T19:00:00' });
    const pastB = makeItem({ _id: 'pastB', timeStart: '2026-08-25T18:00:00', timeEnd: '2026-08-25T19:00:00' });

    it('is empty when the shown occurrence is the only one', () => {
        expect(remainingOccurrencesLabel([a], a, now)).toBe('');
    });

    it('counts the occurrences after the shown one', () => {
        expect(remainingOccurrencesLabel([a, b, c], a, now)).toBe('2 more after this one');
    });

    it('still counts right once the shown occurrence became an exception and left the collapsed list', () => {
        expect(remainingOccurrencesLabel([b, c], a, now)).toBe('2 more after this one');
    });

    it('is empty for a series with nothing generated yet', () => {
        expect(remainingOccurrencesLabel([], undefined, now)).toBe('');
    });

    it('names the other overdue occurrences apart from the upcoming ones', () => {
        expect(remainingOccurrencesLabel([pastA, pastB, a, b], pastA, now)).toBe('1 more overdue · 2 upcoming');
    });

    it('counts an overdue shown occurrence with only upcoming ones after it as a plain tail', () => {
        expect(remainingOccurrencesLabel([pastB, a, b], pastB, now)).toBe('2 more after this one');
    });

    it('names overdue occurrences alone when nothing is upcoming', () => {
        expect(remainingOccurrencesLabel([pastA, pastB], pastA, now)).toBe('1 more overdue');
    });
});

describe('overdueOccurrences', () => {
    const now = dayjs('2026-09-01T12:00:00');

    it('keeps the occurrences whose end has passed, in their given order', () => {
        const past = makeItem({ _id: 'past', timeStart: '2026-08-25T09:00:00', timeEnd: '2026-08-25T10:00:00' });
        const ongoing = makeItem({ _id: 'ongoing', timeStart: '2026-09-01T11:30:00', timeEnd: '2026-09-01T12:30:00' });
        const future = makeItem({ _id: 'future', timeStart: '2026-09-02T09:00:00', timeEnd: '2026-09-02T10:00:00' });
        expect(overdueOccurrences([past, ongoing, future], now).map((item) => item._id)).toEqual(['past']);
    });
});

describe('needsOverdueChoice', () => {
    const now = dayjs('2026-09-01T12:00:00');
    const pastA = makeItem({ _id: 'pastA', timeStart: '2026-08-18T09:00:00', timeEnd: '2026-08-18T10:00:00' });
    const pastB = makeItem({ _id: 'pastB', timeStart: '2026-08-25T09:00:00', timeEnd: '2026-08-25T10:00:00' });
    const future = makeItem({ _id: 'future', timeStart: '2026-09-08T09:00:00', timeEnd: '2026-09-08T10:00:00' });

    it('asks when the shown occurrence is overdue and another overdue one is still open', () => {
        expect(needsOverdueChoice([pastA, pastB, future], pastA, now)).toBe(true);
    });

    it('does not ask when the shown occurrence is the only overdue one', () => {
        expect(needsOverdueChoice([pastB, future], pastB, now)).toBe(false);
    });

    it('does not ask for an upcoming occurrence', () => {
        expect(needsOverdueChoice([future], future, now)).toBe(false);
    });
});

describe('nextOverdueOccurrence', () => {
    const now = dayjs('2026-09-01T12:00:00');
    const pastA = makeItem({ _id: 'pastA', timeStart: '2026-08-18T09:00:00', timeEnd: '2026-08-18T10:00:00' });
    const pastB = makeItem({ _id: 'pastB', timeStart: '2026-08-25T09:00:00', timeEnd: '2026-08-25T10:00:00' });
    const future = makeItem({ _id: 'future', timeStart: '2026-09-08T09:00:00', timeEnd: '2026-09-08T10:00:00' });

    it('is the first overdue occurrence the card has not just disposed of', () => {
        expect(nextOverdueOccurrence([pastA, pastB, future], new Set(['pastA']), now)?._id).toBe('pastB');
    });

    it('is undefined once every overdue occurrence is disposed of — the upcoming ones never count', () => {
        expect(nextOverdueOccurrence([pastA, pastB, future], new Set(['pastA', 'pastB']), now)).toBeUndefined();
    });
});

describe('planOverdueDisposal', () => {
    const pastA = makeItem({ _id: 'pastA', timeStart: '2026-08-18T09:00:00' });
    const pastB = makeItem({ _id: 'pastB', timeStart: '2026-08-25T09:00:00' });
    const pastC = makeItem({ _id: 'pastC', timeStart: '2026-08-28T09:00:00' });
    const ids = (items: ReadonlyArray<StoredItem>) => items.map((item) => item._id);

    it('completes every overdue occurrence for allDone', () => {
        const plan = planOverdueDisposal('allDone', pastA, [pastA, pastB, pastC]);
        expect({ done: ids(plan.done), missed: ids(plan.missed) }).toEqual({ done: ['pastA', 'pastB', 'pastC'], missed: [] });
    });

    it('completes only the shown occurrence for thisOneDone', () => {
        const plan = planOverdueDisposal('thisOneDone', pastB, [pastA, pastB, pastC]);
        expect({ done: ids(plan.done), missed: ids(plan.missed) }).toEqual({ done: ['pastB'], missed: [] });
    });

    it('completes the shown occurrence and marks the other overdue ones missed for thisDoneRestMissed', () => {
        const plan = planOverdueDisposal('thisDoneRestMissed', pastA, [pastA, pastB, pastC]);
        expect({ done: ids(plan.done), missed: ids(plan.missed) }).toEqual({ done: ['pastA'], missed: ['pastB', 'pastC'] });
    });
});

describe('overdueDatesLabel', () => {
    const at = (id: string, timeStart: string) => makeItem({ _id: id, timeStart });

    it('lists every date when there are few', () => {
        expect(overdueDatesLabel([at('a', '2026-08-18T09:00:00'), at('b', '2026-08-19T09:00:00')], dayjs('2026-09-01'))).toBe(
            'Tue, Aug 18 09:00 and Wed, Aug 19 09:00',
        );
    });

    it('lists four dates in full — a cap would only save one', () => {
        const days = ['17', '18', '19', '20'].map((day) => at(day, `2026-08-${day}T09:00:00`));
        expect(overdueDatesLabel(days, dayjs('2026-09-01'))).toBe('Mon, Aug 17 09:00, Tue, Aug 18 09:00, Wed, Aug 19 09:00 and Thu, Aug 20 09:00');
    });

    it('names a single date alone, and an all-day occurrence without a time', () => {
        expect(overdueDatesLabel([makeItem({ _id: 'allDay', timeStart: '2026-08-18', allDay: true })], dayjs('2026-09-01'))).toBe('Tue, Aug 18');
    });

    it('caps a long backlog with a count of the rest', () => {
        const days = ['17', '18', '19', '20', '21', '22'].map((day) => at(day, `2026-08-${day}T09:00:00`));
        expect(overdueDatesLabel(days, dayjs('2026-09-01'))).toBe('Mon, Aug 17 09:00, Tue, Aug 18 09:00, Wed, Aug 19 09:00 and 3 more');
    });
});

describe('resolveOverdueChoice', () => {
    // The chooser stays open across syncs: what it writes is re-read from the live rows at choose time.
    const now = dayjs('2026-09-01T12:00:00');
    const routine = makeRoutine({ _id: 'r1' });
    const occurrenceOn = (id: string, day: string, overrides: Partial<StoredItem> = {}) =>
        makeItem({ _id: id, routineId: 'r1', timeStart: `2026-08-${day}T09:00:00`, timeEnd: `2026-08-${day}T09:15:00`, ...overrides });
    const asked = { shownId: 'a', overdueIds: ['a', 'b', 'c'] };

    it('resolves the asked ids to the live rows, picking up a remote edit', () => {
        const live = [occurrenceOn('a', '18'), occurrenceOn('b', '19', { title: 'edited elsewhere' }), occurrenceOn('c', '20')];
        const resolved = resolveOverdueChoice(collapsedOccurrences(routine, live), asked, now);
        if (!resolved) {
            throw new Error('expected the asked occurrences to resolve');
        }
        expect(resolved.shown._id).toBe('a');
        expect(resolved.overdue.map((row) => row.title)).toEqual(['a', 'edited elsewhere', 'c']);
    });

    it('drops an occurrence completed on another device meanwhile', () => {
        const live = [occurrenceOn('a', '18'), occurrenceOn('b', '19', { status: 'done' }), occurrenceOn('c', '20')];
        const resolved = resolveOverdueChoice(collapsedOccurrences(routine, live), asked, now);
        if (!resolved) {
            throw new Error('expected the asked occurrences to resolve');
        }
        expect(resolved.overdue.map((row) => row._id)).toEqual(['a', 'c']);
    });

    it('drops an occurrence that became a modified exception — it reviews as its own card', () => {
        const withException = makeRoutine({ _id: 'r1', routineExceptions: [{ date: '2026-08-20', type: 'modified', itemId: 'c' }] });
        const live = [occurrenceOn('a', '18'), occurrenceOn('b', '19'), occurrenceOn('c', '20')];
        const resolved = resolveOverdueChoice(collapsedOccurrences(withException, live), asked, now);
        if (!resolved) {
            throw new Error('expected the asked occurrences to resolve');
        }
        expect(resolved.overdue.map((row) => row._id)).toEqual(['a', 'b']);
    });

    it('resolves nothing when the occurrence the user pressed Done on is gone', () => {
        const live = [occurrenceOn('a', '18', { status: 'trash' }), occurrenceOn('b', '19'), occurrenceOn('c', '20')];
        expect(resolveOverdueChoice(collapsedOccurrences(routine, live), asked, now)).toBeUndefined();
    });
});
