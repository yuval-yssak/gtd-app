/**
 * Pure-helper coverage for RoutineEditorBody. The full editor needs jsdom (not configured for
 * this project), so the all-day toggle logic is tested via the extracted `buildRoutineTemplateFromForm`
 * helper — which is the same function the editor calls during onSave.
 */
import { describe, expect, it } from 'vitest';
import { buildRoutineTemplateFromForm, buildSplitPatch, buildUpdatedRoutine } from '../components/routineEditor/RoutineEditorBody';
import type { StoredRoutine } from '../types/MyDB';

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

const BASE_CTX = {
    trimmedTitle: 'Renamed',
    finalRrule: 'FREQ=WEEKLY;BYDAY=MO',
    routineType: 'nextAction' as const,
    template: { energy: 'high' as const },
    calendarItemTemplate: undefined,
    calendarLink: {} as Record<string, never>,
    formStartDate: undefined,
};

// Locks in the in-place update payload that both edit branches write to IDB. The startDate
// handling is the trickiest piece: an empty form value MUST clear a previously-set startDate
// on the routine, not silently preserve it.
describe('buildUpdatedRoutine', () => {
    it('overlays title / rrule / routineType / template onto the existing routine', () => {
        const updated = buildUpdatedRoutine(BASE_ROUTINE, BASE_CTX, undefined);
        expect(updated).toMatchObject({
            _id: BASE_ROUTINE._id,
            userId: BASE_ROUTINE.userId,
            title: 'Renamed',
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            routineType: 'nextAction',
            template: { energy: 'high' },
        });
    });

    it('omits `active` when undefined so the spread does not overwrite the routine value', () => {
        const updated = buildUpdatedRoutine({ ...BASE_ROUTINE, active: false }, BASE_CTX, undefined);
        expect(updated.active).toBe(false);
    });

    it('sets active=true when explicitly passed', () => {
        const updated = buildUpdatedRoutine({ ...BASE_ROUTINE, active: false }, BASE_CTX, true);
        expect(updated.active).toBe(true);
    });

    it('clears a previously-set startDate when formStartDate is undefined', () => {
        const updated = buildUpdatedRoutine({ ...BASE_ROUTINE, startDate: '2026-06-01' }, BASE_CTX, undefined);
        expect(updated.startDate).toBeUndefined();
        expect('startDate' in updated).toBe(false);
    });

    it('sets startDate when formStartDate is provided', () => {
        const updated = buildUpdatedRoutine(BASE_ROUTINE, { ...BASE_CTX, formStartDate: '2026-07-01' }, undefined);
        expect(updated.startDate).toBe('2026-07-01');
    });

    it('emits calendarItemTemplate only when provided', () => {
        const allDayCtx = { ...BASE_CTX, routineType: 'calendar' as const, calendarItemTemplate: { allDay: true } as const };
        const updated = buildUpdatedRoutine(BASE_ROUTINE, allDayCtx, undefined);
        expect(updated.calendarItemTemplate).toEqual({ allDay: true });
    });

    it('spreads calendarLink fields onto the updated routine', () => {
        const updated = buildUpdatedRoutine(
            BASE_ROUTINE,
            { ...BASE_CTX, routineType: 'calendar', calendarLink: { calendarIntegrationId: 'i-1', calendarSyncConfigId: 'c-1' } },
            undefined,
        );
        expect(updated.calendarIntegrationId).toBe('i-1');
        expect(updated.calendarSyncConfigId).toBe('c-1');
    });

    it('overwrites an existing startDate when formStartDate is provided', () => {
        const updated = buildUpdatedRoutine({ ...BASE_ROUTINE, startDate: '2026-01-01' }, { ...BASE_CTX, formStartDate: '2026-07-01' }, undefined);
        expect(updated.startDate).toBe('2026-07-01');
    });
});

// Locks in the editedFields payload passed to splitRoutine. Both call sites (donePast-split and
// scheduleChanged-split) must produce identical shapes — the helper is the single source of truth.
describe('buildSplitPatch', () => {
    it('returns the routineType / title / rrule / template fields', () => {
        const patch = buildSplitPatch(BASE_CTX);
        expect(patch).toMatchObject({
            routineType: 'nextAction',
            title: 'Renamed',
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            template: { energy: 'high' },
        });
    });

    it('omits calendarItemTemplate / startDate when not set on the ctx', () => {
        const patch = buildSplitPatch(BASE_CTX);
        expect('calendarItemTemplate' in patch).toBe(false);
        expect('startDate' in patch).toBe(false);
    });

    it('emits calendarItemTemplate when provided (timed)', () => {
        const patch = buildSplitPatch({ ...BASE_CTX, routineType: 'calendar', calendarItemTemplate: { timeOfDay: '09:00', duration: 60 } });
        expect(patch.calendarItemTemplate).toEqual({ timeOfDay: '09:00', duration: 60 });
    });

    it('emits startDate when provided', () => {
        const patch = buildSplitPatch({ ...BASE_CTX, formStartDate: '2026-06-15' });
        expect(patch.startDate).toBe('2026-06-15');
    });

    it('spreads calendarLink fields when present', () => {
        const patch = buildSplitPatch({
            ...BASE_CTX,
            routineType: 'calendar',
            calendarLink: { calendarIntegrationId: 'i-1', calendarSyncConfigId: 'c-1' },
        });
        expect(patch.calendarIntegrationId).toBe('i-1');
        expect(patch.calendarSyncConfigId).toBe('c-1');
    });
});
