/**
 * Pure-helper coverage for RoutineEditorBody. The full editor needs jsdom (not configured for
 * this project), so the all-day toggle logic is tested via the extracted `buildRoutineTemplateFromForm`
 * helper — which is the same function the editor calls during onSave.
 */
import { describe, expect, it } from 'vitest';
import { buildRoutineTemplateFromForm } from '../components/routineEditor/RoutineEditorBody';

describe('buildRoutineTemplateFromForm', () => {
    it('returns undefined for non-calendar routines (template only applies to calendar)', () => {
        expect(buildRoutineTemplateFromForm({ routineType: 'nextAction', allDay: false, timeOfDay: '09:00', duration: '60' })).toBeUndefined();
        // Even with allDay on, a nextAction routine has no calendarItemTemplate.
        expect(buildRoutineTemplateFromForm({ routineType: 'nextAction', allDay: true, timeOfDay: '09:00', duration: '60' })).toBeUndefined();
    });

    it('returns { allDay: true } when the toggle is on for a calendar routine', () => {
        // timeOfDay/duration are ignored — the hidden inputs keep their defaults but must not leak through.
        expect(buildRoutineTemplateFromForm({ routineType: 'calendar', allDay: true, timeOfDay: '09:00', duration: '60' })).toEqual({ allDay: true });
    });

    it('returns { timeOfDay, duration } when the toggle is off for a calendar routine', () => {
        expect(buildRoutineTemplateFromForm({ routineType: 'calendar', allDay: false, timeOfDay: '10:30', duration: '45' })).toEqual({
            timeOfDay: '10:30',
            duration: 45,
        });
    });

    it('coerces a malformed duration string to the default 60 minutes (matches inline fallback)', () => {
        // Mirrors the editor's existing `parseInt(form.duration, 10) || 60` behavior so saves
        // don't write `NaN` to the routine doc.
        expect(buildRoutineTemplateFromForm({ routineType: 'calendar', allDay: false, timeOfDay: '09:00', duration: 'abc' })).toEqual({
            timeOfDay: '09:00',
            duration: 60,
        });
    });
});
