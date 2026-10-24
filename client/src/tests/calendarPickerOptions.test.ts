import { describe, expect, it } from 'vitest';
import { calendarPickerOptions } from '../components/routineEditor/RoutineScheduleFields';
import type { CalendarOption } from '../hooks/useCalendarOptions';

function calendar(configId: string, accountEmail: string): CalendarOption {
    return { configId, integrationId: `int-${accountEmail}`, userId: `user-${accountEmail}`, accountEmail, displayName: `Cal ${configId}`, isDefault: false };
}

describe('calendarPickerOptions', () => {
    it('lists Default first, ungrouped when every calendar belongs to one account', () => {
        expect(calendarPickerOptions([calendar('a', 'me@x.com'), calendar('b', 'me@x.com')])).toEqual([
            { value: '', label: 'Default' },
            { value: 'a', label: 'Cal a' },
            { value: 'b', label: 'Cal b' },
        ]);
    });

    // Accounts keep the order they first appear in (the options' own order), each listed together.
    it('groups calendars under their account once there are several, in first-appearance order', () => {
        const options = calendarPickerOptions([calendar('w1', 'work@x.com'), calendar('p1', 'me@x.com'), calendar('w2', 'work@x.com')]);
        expect(options).toEqual([
            { value: '', label: 'Default' },
            { value: 'w1', label: 'Cal w1', group: 'work@x.com' },
            { value: 'w2', label: 'Cal w2', group: 'work@x.com' },
            { value: 'p1', label: 'Cal p1', group: 'me@x.com' },
        ]);
    });
});
