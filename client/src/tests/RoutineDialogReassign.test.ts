import { describe, expect, it } from 'vitest';
import { buildRoutineEditPatch } from '../components/routines/RoutineDialog';
import type { StoredRoutine } from '../types/MyDB';

const BASE_ROUTINE: StoredRoutine = {
    _id: 'r-1',
    userId: 'user-A',
    title: 'Morning standup',
    routineType: 'nextAction',
    rrule: 'FREQ=DAILY',
    template: { energy: 'medium' },
    active: true,
    createdTs: '2026-01-01T00:00:00.000Z',
    updatedTs: '2026-01-01T00:00:00.000Z',
};

// Locks in the cross-account routine save invariants:
// - Diffs each whitelisted field against the routine's current value; emits only the changes.
// - Always emits `template` (so chip toggles are picked up — the server overwrites the whole
//   template object atomically with the move, matching the same-account in-place semantics).
// - startDate diffing uses '' as "absent" so flipping between unset and a real date round-trips
//   cleanly through the empty-string-clears server convention.
describe('buildRoutineEditPatch', () => {
    it('returns an object with template only when nothing else changed', () => {
        const patch = buildRoutineEditPatch({
            routine: BASE_ROUTINE,
            title: BASE_ROUTINE.title,
            rrule: BASE_ROUTINE.rrule,
            routineType: BASE_ROUTINE.routineType,
            template: BASE_ROUTINE.template,
        });
        expect(patch).toEqual({ template: BASE_ROUTINE.template });
    });

    it('emits title when changed', () => {
        const patch = buildRoutineEditPatch({
            routine: BASE_ROUTINE,
            title: 'Renamed',
            rrule: BASE_ROUTINE.rrule,
            routineType: BASE_ROUTINE.routineType,
            template: BASE_ROUTINE.template,
        });
        expect(patch.title).toBe('Renamed');
    });

    it('emits rrule when changed', () => {
        const patch = buildRoutineEditPatch({
            routine: BASE_ROUTINE,
            title: BASE_ROUTINE.title,
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            routineType: BASE_ROUTINE.routineType,
            template: BASE_ROUTINE.template,
        });
        expect(patch.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
    });

    it('emits routineType when flipping from nextAction to calendar', () => {
        const patch = buildRoutineEditPatch({
            routine: BASE_ROUTINE,
            title: BASE_ROUTINE.title,
            rrule: BASE_ROUTINE.rrule,
            routineType: 'calendar',
            template: BASE_ROUTINE.template,
            calendarItemTemplate: { timeOfDay: '09:00', duration: 60 },
        });
        expect(patch.routineType).toBe('calendar');
        expect(patch.calendarItemTemplate).toEqual({ timeOfDay: '09:00', duration: 60 });
    });

    it('emits startDate when set on a previously-unset routine', () => {
        const patch = buildRoutineEditPatch({
            routine: BASE_ROUTINE,
            title: BASE_ROUTINE.title,
            rrule: BASE_ROUTINE.rrule,
            routineType: BASE_ROUTINE.routineType,
            template: BASE_ROUTINE.template,
            startDate: '2026-06-01',
        });
        expect(patch.startDate).toBe('2026-06-01');
    });

    it('emits startDate as "" when clearing a previously-set startDate', () => {
        const routineWithStart: StoredRoutine = { ...BASE_ROUTINE, startDate: '2026-06-01' };
        const patch = buildRoutineEditPatch({
            routine: routineWithStart,
            title: routineWithStart.title,
            rrule: routineWithStart.rrule,
            routineType: routineWithStart.routineType,
            template: routineWithStart.template,
            // omit startDate
        });
        expect(patch.startDate).toBe('');
    });

    it('does NOT emit startDate when both original and form are unset', () => {
        const patch = buildRoutineEditPatch({
            routine: BASE_ROUTINE,
            title: BASE_ROUTINE.title,
            rrule: BASE_ROUTINE.rrule,
            routineType: BASE_ROUTINE.routineType,
            template: BASE_ROUTINE.template,
            // no startDate
        });
        expect(patch.startDate).toBeUndefined();
    });

    it('always emits template (so chip toggles are persisted via the patch)', () => {
        const patch = buildRoutineEditPatch({
            routine: BASE_ROUTINE,
            title: BASE_ROUTINE.title,
            rrule: BASE_ROUTINE.rrule,
            routineType: BASE_ROUTINE.routineType,
            template: { energy: 'high', urgent: true },
        });
        expect(patch.template).toEqual({ energy: 'high', urgent: true });
    });

    it('emits active=true when resuming a paused routine via cross-account save', () => {
        const paused: StoredRoutine = { ...BASE_ROUTINE, active: false };
        const patch = buildRoutineEditPatch({
            routine: paused,
            title: paused.title,
            rrule: paused.rrule,
            routineType: paused.routineType,
            template: paused.template,
            resumeOnSave: true,
        });
        expect(patch.active).toBe(true);
    });

    it('does not emit active when the routine is already active and resumeOnSave is omitted', () => {
        const patch = buildRoutineEditPatch({
            routine: BASE_ROUTINE,
            title: BASE_ROUTINE.title,
            rrule: BASE_ROUTINE.rrule,
            routineType: BASE_ROUTINE.routineType,
            template: BASE_ROUTINE.template,
        });
        expect(patch.active).toBeUndefined();
    });
});
