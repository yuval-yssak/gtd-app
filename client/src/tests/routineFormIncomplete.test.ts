import { describe, expect, it } from 'vitest';
import { initFormState, isRoutineFormIncomplete } from '../components/routineEditor/routineFormState';

// TimeField's Clear button makes an empty Start time reachable in one tap on a phone; the save gate
// must hold rather than letting a timed calendar routine save without a time.

function timedCalendarForm(timeOfDay: string, allDay = false) {
    return { ...initFormState(), routineType: 'calendar' as const, allDay, timeOfDay };
}

describe('isRoutineFormIncomplete — cleared Start time', () => {
    it('blocks a timed calendar routine whose Start time was cleared', () => {
        expect(isRoutineFormIncomplete(timedCalendarForm(''))).toBe(true);
    });

    it('accepts the same routine once a time is entered again', () => {
        expect(isRoutineFormIncomplete(timedCalendarForm('07:30'))).toBe(false);
    });

    it('does not require a time for an all-day calendar routine', () => {
        expect(isRoutineFormIncomplete(timedCalendarForm('', true))).toBe(false);
    });
});
