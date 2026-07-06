import { describe, expect, it } from 'vitest';
import { isNextActionScheduleChanged } from '../components/routines/routineEditDecision';
import { computeFirstOccurrenceDate, mergeRoutineEditIntoOpenItem, stampedItemContent } from '../lib/routineOpenItemMerge';
import { RruleExhaustedError } from '../lib/rruleUtils';
import type { StoredItem, StoredRoutine, StoredRoutineTemplate } from '../types/MyDB';

// KEEP IN SYNC: api-server/src/tests/routineOpenItemMerge.test.ts runs the same merge/anchor
// vector matrix against the server mirror. When adding a vector here, add it there too.

const NOW = '2026-07-05T12:00:00.000Z';

function makeRoutine(title: string, template: StoredRoutineTemplate, overrides: Partial<StoredRoutine> = {}): StoredRoutine {
    return {
        _id: 'r-1',
        userId: 'u-1',
        title,
        routineType: 'nextAction',
        rrule: 'FREQ=DAILY;INTERVAL=1',
        template,
        active: true,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

/** An open item as the generator would have stamped it from `routine`, plus any hand-tweaks. */
function makeGeneratedItem(routine: StoredRoutine, tweaks: Partial<StoredItem> = {}): StoredItem {
    return {
        _id: 'i-1',
        userId: 'u-1',
        status: 'nextAction',
        routineId: routine._id,
        expectedBy: '2026-07-06',
        ignoreBefore: '2026-07-06',
        createdTs: '2026-07-01T00:00:00.000Z',
        updatedTs: '2026-07-01T00:00:00.000Z',
        ...stampedItemContent(routine),
        ...tweaks,
    };
}

describe('mergeRoutineEditIntoOpenItem', () => {
    it('adopts a newly added work context and people list on a clean item', () => {
        const previous = makeRoutine('Water plants', {});
        const next = makeRoutine('Water plants', { workContextIds: ['wc-1'], peopleIds: ['p-1'] });
        const item = makeGeneratedItem(previous);
        const merged = mergeRoutineEditIntoOpenItem(item, { previous, next, now: NOW });
        expect(merged).not.toBeNull();
        expect(merged?.workContextIds).toEqual(['wc-1']);
        expect(merged?.peopleIds).toEqual(['p-1']);
        expect(merged?.updatedTs).toBe(NOW);
    });

    it('adopts a title rename when the item title is untouched', () => {
        const previous = makeRoutine('Water plants', {});
        const next = makeRoutine('Water the plants', {});
        const item = makeGeneratedItem(previous);
        const merged = mergeRoutineEditIntoOpenItem(item, { previous, next, now: NOW });
        expect(merged?.title).toBe('Water the plants');
    });

    it('preserves a hand-renamed item title', () => {
        const previous = makeRoutine('Water plants', {});
        const next = makeRoutine('Water the plants', {});
        const item = makeGeneratedItem(previous, { title: 'Water plants (balcony only)' });
        expect(mergeRoutineEditIntoOpenItem(item, { previous, next, now: NOW })).toBeNull();
    });

    it('preserves a hand-tweaked energy while adopting other changed fields', () => {
        const previous = makeRoutine('Water plants', { energy: 'low', time: 10 });
        const next = makeRoutine('Water plants', { energy: 'high', time: 20 });
        const item = makeGeneratedItem(previous, { energy: 'medium' });
        const merged = mergeRoutineEditIntoOpenItem(item, { previous, next, now: NOW });
        expect(merged?.energy).toBe('medium');
        expect(merged?.time).toBe(20);
    });

    it('treats value-equal arrays as clean even when references differ', () => {
        const previous = makeRoutine('Water plants', { workContextIds: ['wc-1', 'wc-2'] });
        const next = makeRoutine('Water plants', { workContextIds: ['wc-3'] });
        const item = makeGeneratedItem(previous, { workContextIds: ['wc-1', 'wc-2'] });
        const merged = mergeRoutineEditIntoOpenItem(item, { previous, next, now: NOW });
        expect(merged?.workContextIds).toEqual(['wc-3']);
    });

    it('preserves a hand-reordered work context list (arrays compare element-wise)', () => {
        const previous = makeRoutine('Water plants', { workContextIds: ['wc-1', 'wc-2'] });
        const next = makeRoutine('Water plants', { workContextIds: ['wc-3'] });
        const item = makeGeneratedItem(previous, { workContextIds: ['wc-2', 'wc-1'] });
        expect(mergeRoutineEditIntoOpenItem(item, { previous, next, now: NOW })).toBeNull();
    });

    it('deletes a field the new template no longer sets', () => {
        const previous = makeRoutine('Water plants', { energy: 'low', notes: 'use rainwater' });
        const next = makeRoutine('Water plants', {});
        const item = makeGeneratedItem(previous);
        const merged = mergeRoutineEditIntoOpenItem(item, { previous, next, now: NOW });
        expect(merged).not.toBeNull();
        expect(merged && 'energy' in merged).toBe(false);
        expect(merged && 'notes' in merged).toBe(false);
    });

    it('adds notes to an item that had none', () => {
        const previous = makeRoutine('Water plants', {});
        const next = makeRoutine('Water plants', { notes: 'check soil first' });
        const item = makeGeneratedItem(previous);
        const merged = mergeRoutineEditIntoOpenItem(item, { previous, next, now: NOW });
        expect(merged?.notes).toBe('check soil first');
    });

    it('adopts focus/urgent toggles on a clean item', () => {
        const previous = makeRoutine('Water plants', { focus: false, urgent: false });
        const next = makeRoutine('Water plants', { focus: true, urgent: true });
        const item = makeGeneratedItem(previous);
        const merged = mergeRoutineEditIntoOpenItem(item, { previous, next, now: NOW });
        expect(merged?.focus).toBe(true);
        expect(merged?.urgent).toBe(true);
    });

    it('adopts time:0 (defined-but-falsy) rather than treating it as unset', () => {
        const previous = makeRoutine('Water plants', { time: 10 });
        const next = makeRoutine('Water plants', { time: 0 });
        const item = makeGeneratedItem(previous);
        const merged = mergeRoutineEditIntoOpenItem(item, { previous, next, now: NOW });
        expect(merged?.time).toBe(0);
    });

    it('deletes focus/urgent when the new template omits them (boolean presence rule)', () => {
        const previous = makeRoutine('Water plants', { focus: true, urgent: true });
        const next = makeRoutine('Water plants', {});
        const item = makeGeneratedItem(previous);
        const merged = mergeRoutineEditIntoOpenItem(item, { previous, next, now: NOW });
        expect(merged).not.toBeNull();
        expect(merged && 'focus' in merged).toBe(false);
        expect(merged && 'urgent' in merged).toBe(false);
    });

    it('adopts a title rename and an optional-field change in the same edit', () => {
        const previous = makeRoutine('Water plants', { energy: 'low' });
        const next = makeRoutine('Water the plants', { energy: 'high' });
        const item = makeGeneratedItem(previous);
        const merged = mergeRoutineEditIntoOpenItem(item, { previous, next, now: NOW });
        expect(merged?.title).toBe('Water the plants');
        expect(merged?.energy).toBe('high');
        expect(merged?.updatedTs).toBe(NOW);
    });

    it('returns null when the edit changed nothing the item carries', () => {
        const previous = makeRoutine('Water plants', { energy: 'low' });
        const next = makeRoutine('Water plants', { energy: 'low' });
        const item = makeGeneratedItem(previous);
        expect(mergeRoutineEditIntoOpenItem(item, { previous, next, now: NOW })).toBeNull();
    });

    it('leaves schedule and identity fields untouched on a content merge', () => {
        const previous = makeRoutine('Water plants', {});
        const next = makeRoutine('Water plants', { energy: 'high' });
        const item = makeGeneratedItem(previous);
        const merged = mergeRoutineEditIntoOpenItem(item, { previous, next, now: NOW });
        expect(merged?._id).toBe(item._id);
        expect(merged?.status).toBe('nextAction');
        expect(merged?.routineId).toBe(item.routineId);
        expect(merged?.expectedBy).toBe(item.expectedBy);
        expect(merged?.ignoreBefore).toBe(item.ignoreBefore);
        expect(merged?.createdTs).toBe(item.createdTs);
    });
});

describe('computeFirstOccurrenceDate', () => {
    it('lands a daily rule on today itself (includeAnchor semantics)', () => {
        expect(computeFirstOccurrenceDate({ rrule: 'FREQ=DAILY;INTERVAL=1' }, '2026-07-06')).toBe('2026-07-06');
    });

    it('advances a weekly BYDAY rule to the next matching weekday', () => {
        // 2026-07-06 is a Monday; BYDAY=WE lands on Wednesday the 8th.
        expect(computeFirstOccurrenceDate({ rrule: 'FREQ=WEEKLY;BYDAY=WE' }, '2026-07-06')).toBe('2026-07-08');
    });

    it('anchors at a future startDate instead of today', () => {
        expect(computeFirstOccurrenceDate({ rrule: 'FREQ=DAILY;INTERVAL=1', startDate: '2026-08-01' }, '2026-07-06')).toBe('2026-08-01');
    });

    it('ignores a past startDate and anchors at today', () => {
        expect(computeFirstOccurrenceDate({ rrule: 'FREQ=DAILY;INTERVAL=1', startDate: '2026-01-01' }, '2026-07-06')).toBe('2026-07-06');
    });

    it('throws RruleExhaustedError when the rrule has no future occurrence', () => {
        expect(() => computeFirstOccurrenceDate({ rrule: 'FREQ=DAILY;UNTIL=20260101T000000Z' }, '2026-07-06')).toThrow(RruleExhaustedError);
    });
});

describe('isNextActionScheduleChanged', () => {
    const intent = (rrule: string, routineType: 'nextAction' | 'calendar' = 'nextAction') => ({
        routineType,
        rrule,
        timeOfDay: undefined,
        duration: undefined,
    });

    it('detects a recurrence change', () => {
        const previous = makeRoutine('Water plants', {}, { rrule: 'FREQ=DAILY;INTERVAL=1' });
        expect(isNextActionScheduleChanged(previous, intent('FREQ=WEEKLY;BYDAY=MO'))).toBe(true);
    });

    it('ignores cosmetic rrule differences (BYDAY order, clause order)', () => {
        const previous = makeRoutine('Water plants', {}, { rrule: 'FREQ=WEEKLY;BYDAY=MO,WE' });
        expect(isNextActionScheduleChanged(previous, intent('BYDAY=WE,MO;FREQ=WEEKLY'))).toBe(false);
    });

    it('never fires for calendar routines or type switches', () => {
        const calendarPrevious = makeRoutine('Standup', {}, { routineType: 'calendar' });
        expect(isNextActionScheduleChanged(calendarPrevious, intent('FREQ=WEEKLY;BYDAY=FR', 'calendar'))).toBe(false);
        const naPrevious = makeRoutine('Water plants', {});
        expect(isNextActionScheduleChanged(naPrevious, intent('FREQ=WEEKLY;BYDAY=FR', 'calendar'))).toBe(false);
    });
});
