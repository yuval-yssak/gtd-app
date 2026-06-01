import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { GoogleCalendar } from '../api/calendarApi';
import { calendarSelectRows } from '../components/settings/CalendarIntegrations';

function cal(id: string, name: string, opts?: { primary?: boolean; accessRole?: string }): GoogleCalendar {
    return { id, name, primary: opts?.primary ?? false, accessRole: opts?.accessRole ?? 'reader' };
}

/**
 * MUI `<Select>` resolves its options via `React.Children.toArray(children)` over its *direct*
 * children — it does not recurse into a fragment or wrapper component. So `calendarSelectRows` MUST
 * return a flat array of elements (spread directly as Select children), and only the selectable
 * rows may carry a `value` prop. These tests pin that contract so a regression to a fragment-returning
 * component (which silently breaks selection + value display) fails loudly.
 */
describe('calendarSelectRows', () => {
    it('returns a flat array of valid React elements, not a fragment', () => {
        const rows = calendarSelectRows([cal('primary', 'Me', { primary: true }), cal('shared', 'Team', { accessRole: 'reader' })]);
        expect(Array.isArray(rows)).toBe(true);
        expect(rows.every((el) => isValidElement(el))).toBe(true);
    });

    it('gives each calendar option a `value` prop matching its id, in picker order', () => {
        const rows = calendarSelectRows([
            cal('shared', 'Team', { accessRole: 'reader' }),
            cal('owned', 'Work', { accessRole: 'owner' }),
            cal('primary', 'Me', { primary: true }),
        ]);
        const optionValues = rows.map((el) => (el.props as { value?: string }).value).filter((v): v is string => v !== undefined);
        // primary → owned → shared
        expect(optionValues).toEqual(['primary', 'owned', 'shared']);
    });

    it('renders group-header rows without a `value` prop so MUI does not treat them as options', () => {
        const rows = calendarSelectRows([cal('primary', 'Me', { primary: true }), cal('owned', 'Work', { accessRole: 'owner' }), cal('shared', 'Team')]);
        const headerRows = rows.filter((el) => (el.props as { value?: string }).value === undefined);
        // owned + shared headers, never a primary header
        expect(headerRows).toHaveLength(2);
    });

    it('appends a " (primary)" suffix only to the primary option', () => {
        const rows = calendarSelectRows([cal('primary', 'Me', { primary: true }), cal('work', 'Work', { accessRole: 'owner' })]);
        const labelText = (el: (typeof rows)[number]) => (el.props as { children?: unknown }).children;
        const primaryRow = rows.find((el) => (el.props as { value?: string }).value === 'primary');
        const workRow = rows.find((el) => (el.props as { value?: string }).value === 'work');
        if (!primaryRow || !workRow) throw new Error('expected both primary and work option rows');
        // children is [name, suffix]; the suffix is '' for non-primary.
        expect(labelText(primaryRow)).toEqual(['Me', ' (primary)']);
        expect(labelText(workRow)).toEqual(['Work', '']);
    });

    it('returns no rows for an empty calendar list', () => {
        expect(calendarSelectRows([])).toEqual([]);
    });
});
