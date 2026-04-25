import { describe, expect, it } from 'vitest';
import { isCalendarScheduleChanged, isStartDateChanged } from '../components/routines/routineEditDecision';
import type { StoredRoutine } from '../types/MyDB';

function make(overrides: Partial<StoredRoutine> = {}): StoredRoutine {
    const base: StoredRoutine = {
        _id: 'r-1',
        userId: 'u-1',
        title: 'Standup',
        routineType: 'calendar',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        template: {},
        active: true,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
        calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
    };
    return { ...base, ...overrides };
}

function makeNonCalendar(): StoredRoutine {
    return {
        _id: 'r-1',
        userId: 'u-1',
        title: 'Review inbox',
        routineType: 'nextAction',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        template: {},
        active: true,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
    };
}

describe('isCalendarScheduleChanged', () => {
    it('returns false for a title-only change (regression: would previously trigger a split)', () => {
        const previous = make();
        expect(
            isCalendarScheduleChanged(previous, {
                routineType: 'calendar',
                rrule: previous.rrule,
                timeOfDay: '09:00',
                duration: 30,
            }),
        ).toBe(false);
    });

    it('returns true when the rrule changed (e.g. BYDAY MO → TU)', () => {
        const previous = make();
        expect(
            isCalendarScheduleChanged(previous, {
                routineType: 'calendar',
                rrule: 'FREQ=WEEKLY;BYDAY=TU',
                timeOfDay: '09:00',
                duration: 30,
            }),
        ).toBe(true);
    });

    it('returns true when timeOfDay changed', () => {
        const previous = make();
        expect(
            isCalendarScheduleChanged(previous, {
                routineType: 'calendar',
                rrule: previous.rrule,
                timeOfDay: '10:30',
                duration: 30,
            }),
        ).toBe(true);
    });

    it('returns true when duration changed', () => {
        const previous = make();
        expect(
            isCalendarScheduleChanged(previous, {
                routineType: 'calendar',
                rrule: previous.rrule,
                timeOfDay: '09:00',
                duration: 60,
            }),
        ).toBe(true);
    });

    it('returns false for a non-calendar routine edit regardless of rrule change', () => {
        const previous = makeNonCalendar();
        expect(
            isCalendarScheduleChanged(previous, {
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                timeOfDay: undefined,
                duration: undefined,
            }),
        ).toBe(false);
    });

    it('returns false when rrule differs only in clause order (stored BYDAY last → form BYDAY first)', () => {
        // Regression from a live E4 run: stored rrule was FREQ=WEEKLY;UNTIL=...;BYDAY=MO,
        // but the dialog's edit round-trip produced FREQ=WEEKLY;BYDAY=MO;UNTIL=... — same schedule.
        const previous = make({ rrule: 'FREQ=WEEKLY;UNTIL=20260503T205959Z;BYDAY=MO' });
        expect(
            isCalendarScheduleChanged(previous, {
                routineType: 'calendar',
                rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260503T235959Z',
                timeOfDay: '09:00',
                duration: 30,
            }),
        ).toBe(false);
    });

    it('returns false when UNTIL differs only in time-of-day within the same UTC date', () => {
        // parseEndsFromRrule drops UNTIL's time; buildFinalRrule reassembles at 23:59:59Z.
        // Same end date in UTC → no real schedule change.
        const previous = make({ rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260503T000001Z' });
        expect(
            isCalendarScheduleChanged(previous, {
                routineType: 'calendar',
                rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260503T235959Z',
                timeOfDay: '09:00',
                duration: 30,
            }),
        ).toBe(false);
    });

    it('returns true when UNTIL moves to a different UTC date', () => {
        const previous = make({ rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260503T235959Z' });
        expect(
            isCalendarScheduleChanged(previous, {
                routineType: 'calendar',
                rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260510T235959Z',
                timeOfDay: '09:00',
                duration: 30,
            }),
        ).toBe(true);
    });

    it('returns false even when the stored UNTIL is a corrupted "Invalid Date" value', () => {
        // Defensive regression: a prior bug produced UNTIL=Invalid DateT235959Z in some routines.
        // A title-only re-save should not try to "fix" that by treating it as a schedule change.
        const previous = make({ rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=Invalid DateT235959Z' });
        expect(
            isCalendarScheduleChanged(previous, {
                routineType: 'calendar',
                rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=Invalid DateT235959Z',
                timeOfDay: '09:00',
                duration: 30,
            }),
        ).toBe(false);
    });

    it('returns false when BYDAY list is re-ordered', () => {
        const previous = make({ rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR' });
        expect(
            isCalendarScheduleChanged(previous, {
                routineType: 'calendar',
                rrule: 'FREQ=WEEKLY;BYDAY=FR,MO,WE',
                timeOfDay: '09:00',
                duration: 30,
            }),
        ).toBe(false);
    });

    it('returns true when switching from non-calendar to calendar introduces a schedule template', () => {
        const previous = makeNonCalendar();
        expect(
            isCalendarScheduleChanged(previous, {
                routineType: 'calendar',
                rrule: previous.rrule,
                timeOfDay: '09:00',
                duration: 30,
            }),
        ).toBe(true);
    });
});

describe('isStartDateChanged', () => {
    it('returns false when both are unset', () => {
        const previous = make();
        expect(isStartDateChanged(previous, { routineType: 'calendar', rrule: previous.rrule, timeOfDay: '09:00', duration: 30 })).toBe(false);
    });

    it('returns false when the same startDate is re-submitted', () => {
        const previous = make({ startDate: '2026-06-15' });
        expect(
            isStartDateChanged(previous, { routineType: 'calendar', rrule: previous.rrule, timeOfDay: '09:00', duration: 30, startDate: '2026-06-15' }),
        ).toBe(false);
    });

    it('returns true when adding a startDate', () => {
        const previous = make();
        expect(
            isStartDateChanged(previous, { routineType: 'calendar', rrule: previous.rrule, timeOfDay: '09:00', duration: 30, startDate: '2026-06-15' }),
        ).toBe(true);
    });

    it('returns true when clearing a startDate', () => {
        const previous = make({ startDate: '2026-06-15' });
        expect(isStartDateChanged(previous, { routineType: 'calendar', rrule: previous.rrule, timeOfDay: '09:00', duration: 30 })).toBe(true);
    });

    it('treats empty string and undefined as equivalent', () => {
        const previous = make({ startDate: '' });
        expect(isStartDateChanged(previous, { routineType: 'calendar', rrule: previous.rrule, timeOfDay: '09:00', duration: 30 })).toBe(false);
    });
});
