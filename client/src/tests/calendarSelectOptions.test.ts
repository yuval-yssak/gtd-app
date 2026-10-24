import { describe, expect, it } from 'vitest';
import { calendarSelectOptions } from '../components/clarify/CalendarFields';
import type { CalendarOption } from '../hooks/useCalendarOptions';

function calendar(configId: string, accountEmail: string, displayName: string): CalendarOption {
    return { configId, integrationId: `int-${accountEmail}`, userId: `user-${accountEmail}`, accountEmail, displayName, isDefault: false };
}

describe('calendarSelectOptions', () => {
    it('leads with Default (empty value — the server picks the account default) and skips headers for one account', () => {
        expect(calendarSelectOptions([calendar('a1', 'a@example.com', 'Work'), calendar('a2', 'a@example.com', 'Home')])).toEqual([
            { value: '', label: 'Default' },
            { value: 'a1', label: 'Work' },
            { value: 'a2', label: 'Home' },
        ]);
    });

    it('groups calendars under their account, accounts in first-seen order, each group contiguous', () => {
        const options = calendarSelectOptions([
            calendar('b1', 'b@example.com', 'Team'),
            calendar('a1', 'a@example.com', 'Work'),
            calendar('b2', 'b@example.com', 'Launch'),
        ]);
        expect(options.map((option) => [option.value, option.group])).toEqual([
            ['', undefined],
            ['b1', 'b@example.com'],
            ['b2', 'b@example.com'],
            ['a1', 'a@example.com'],
        ]);
    });
});
