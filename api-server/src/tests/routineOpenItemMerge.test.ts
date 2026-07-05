import { describe, expect, it } from 'vitest';
import { computeFirstOccurrenceDate, mergeRoutineEditIntoOpenItem, stampedItemContent } from '../lib/routineOpenItemMerge.js';
import { canonicalRruleKey, isNextActionScheduleChanged } from '../lib/rruleCanonical.js';
import { RruleExhaustedError } from '../lib/rruleHelpers.js';
import type { ItemInterface, RoutineInterface } from '../types/entities.js';

// KEEP IN SYNC: client/src/tests/routineOpenItemMerge.test.ts runs the same merge/anchor
// vector matrix against the client mirror. When adding a vector here, add it there too.

const NOW = '2026-07-05T12:00:00.000Z';

function makeRoutine(title: string, template: RoutineInterface['template'], overrides: Partial<RoutineInterface> = {}): RoutineInterface {
    return {
        _id: 'r-1',
        user: 'u-1',
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
function makeGeneratedItem(routine: RoutineInterface, tweaks: Partial<ItemInterface> = {}): ItemInterface {
    return {
        _id: 'i-1',
        user: 'u-1',
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

describe('canonicalRruleKey / isNextActionScheduleChanged', () => {
    it('canonicalizes clause order, BYDAY order, and UNTIL time-of-day', () => {
        expect(canonicalRruleKey('BYDAY=WE,MO;FREQ=WEEKLY')).toBe(canonicalRruleKey('FREQ=WEEKLY;BYDAY=MO,WE'));
        expect(canonicalRruleKey('FREQ=DAILY;UNTIL=20260801T205959Z')).toBe(canonicalRruleKey('FREQ=DAILY;UNTIL=20260801T235959Z'));
    });

    it('detects a recurrence change', () => {
        const previous = makeRoutine('Water plants', {}, { rrule: 'FREQ=DAILY;INTERVAL=1' });
        const next = makeRoutine('Water plants', {}, { rrule: 'FREQ=WEEKLY;BYDAY=MO' });
        expect(isNextActionScheduleChanged(previous, next)).toBe(true);
    });

    it('detects a startDate change', () => {
        const previous = makeRoutine('Water plants', {});
        const next = makeRoutine('Water plants', {}, { startDate: '2026-08-01' });
        expect(isNextActionScheduleChanged(previous, next)).toBe(true);
    });

    it('ignores cosmetic rrule differences and unset-vs-empty startDate', () => {
        const previous = makeRoutine('Water plants', {}, { rrule: 'FREQ=WEEKLY;BYDAY=MO,WE' });
        const next = makeRoutine('Water plants', {}, { rrule: 'BYDAY=WE,MO;FREQ=WEEKLY' });
        expect(isNextActionScheduleChanged(previous, next)).toBe(false);
    });

    it('never fires for calendar routines or type switches', () => {
        const calendarPrevious = makeRoutine('Standup', {}, { routineType: 'calendar', calendarItemTemplate: { timeOfDay: '09:00', duration: 30 } });
        const calendarNext = makeRoutine(
            'Standup',
            {},
            { routineType: 'calendar', rrule: 'FREQ=WEEKLY;BYDAY=FR', calendarItemTemplate: { timeOfDay: '09:00', duration: 30 } },
        );
        expect(isNextActionScheduleChanged(calendarPrevious, calendarNext)).toBe(false);
        const naPrevious = makeRoutine('Water plants', {});
        expect(isNextActionScheduleChanged(naPrevious, calendarNext)).toBe(false);
    });
});
