import dayjs from 'dayjs';
import { isValidElement, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { __resetDayClockForTests, subscribeToDayChange } from '../lib/dayClock';
import { FocusIndicator, matchesFilters, UnclarifiedWarning } from '../routes/_authenticated/next-actions';
import type { StoredItem } from '../types/MyDB';

const item = (over: Partial<StoredItem>): StoredItem =>
    ({ _id: 'i1', userId: 'u', status: 'nextAction', title: 'T', createdTs: '', updatedTs: '', ...over }) as StoredItem;

describe('matchesFilters', () => {
    it('matches everything when no filters are set', () => {
        expect(matchesFilters(item({}), {})).toBe(true);
    });

    it('filters by energy', () => {
        expect(matchesFilters(item({ energy: 'low' }), { energy: 'low' })).toBe(true);
        expect(matchesFilters(item({ energy: 'high' }), { energy: 'low' })).toBe(false);
        expect(matchesFilters(item({}), { energy: 'low' })).toBe(false);
    });

    it('filters by max time, excluding items with no estimate', () => {
        expect(matchesFilters(item({ time: 5 }), { time: 30 })).toBe(true);
        expect(matchesFilters(item({ time: 60 }), { time: 30 })).toBe(false);
        expect(matchesFilters(item({}), { time: 30 })).toBe(false);
    });

    it('filters by work context id', () => {
        expect(matchesFilters(item({ workContextIds: ['c1', 'c2'] }), { context: 'c2' })).toBe(true);
        expect(matchesFilters(item({ workContextIds: ['c1'] }), { context: 'c2' })).toBe(false);
        expect(matchesFilters(item({}), { context: 'c2' })).toBe(false);
    });

    it('filters by person id via peopleIds', () => {
        expect(matchesFilters(item({ peopleIds: ['p1', 'p2'] }), { person: 'p1' })).toBe(true);
        expect(matchesFilters(item({ peopleIds: ['p2'] }), { person: 'p1' })).toBe(false);
        expect(matchesFilters(item({}), { person: 'p1' })).toBe(false);
    });

    it('matches any id of the expanded same-name group (merged multi-account chips)', () => {
        const groups = { contextIds: new Set(['c1', 'c1-twin']), personIds: new Set(['p1', 'p1-twin']) };
        expect(matchesFilters(item({ workContextIds: ['c1-twin'] }), { context: 'c1' }, groups)).toBe(true);
        expect(matchesFilters(item({ workContextIds: ['c9'] }), { context: 'c1' }, groups)).toBe(false);
        expect(matchesFilters(item({ peopleIds: ['p1-twin'] }), { person: 'p1' }, groups)).toBe(true);
        expect(matchesFilters(item({ peopleIds: ['p9'] }), { person: 'p1' }, groups)).toBe(false);
    });

    it('falls back to exact id matching for a filter with no supplied group', () => {
        const groups = { contextIds: new Set(['c1', 'c1-twin']) }; // no personIds
        expect(matchesFilters(item({ workContextIds: ['c1-twin'], peopleIds: ['p1'] }), { context: 'c1', person: 'p1' }, groups)).toBe(true);
        expect(matchesFilters(item({ workContextIds: ['c1-twin'], peopleIds: ['p-other'] }), { context: 'c1', person: 'p1' }, groups)).toBe(false);
    });

    it('hides ticklered items until their ignoreBefore date, regardless of filters', () => {
        expect(matchesFilters(item({ ignoreBefore: '2999-01-01' }), {})).toBe(false);
        expect(matchesFilters(item({ ignoreBefore: '2000-01-01' }), {})).toBe(true);
    });

    it('judges the tickler boundary against the supplied todayIso — the item appears ON its day, not after', () => {
        const snoozed = item({ ignoreBefore: '2026-06-02' });
        expect(matchesFilters(snoozed, {}, { todayIso: '2026-06-01' })).toBe(false);
        expect(matchesFilters(snoozed, {}, { todayIso: '2026-06-02' })).toBe(true);
        expect(matchesFilters(snoozed, {}, { todayIso: '2026-06-03' })).toBe(true);
    });

    it('the default todayIso reads the shared day clock — a midnight roll flips the same call', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(dayjs('2026-08-29T23:59:00').toDate());
            __resetDayClockForTests();
            const snoozed = item({ ignoreBefore: '2026-08-30' });
            expect(matchesFilters(snoozed, {})).toBe(false);

            subscribeToDayChange(vi.fn());
            vi.advanceTimersByTime(2 * 60 * 1000);
            expect(matchesFilters(snoozed, {})).toBe(true);
        } finally {
            __resetDayClockForTests();
            vi.useRealTimers();
        }
    });
});

// Node-env tests (no DOM): call the components as functions and assert on the returned element tree.
const tooltipChild = (el: ReactElement) => {
    const { title, children } = el.props as { title?: string; children?: unknown };
    return { title, child: isValidElement(children) ? children : undefined };
};

describe('FocusIndicator', () => {
    it('wraps a primary-colored icon with an "In focus" tooltip and a camelCase testid', () => {
        const { title, child } = tooltipChild(FocusIndicator());
        expect(title).toBe('In focus');
        if (!child) throw new Error('expected an icon child inside the Tooltip');
        expect(child.props).toMatchObject({ fontSize: 'small', color: 'primary', 'data-testid': 'focusIndicator' });
    });
});

describe('UnclarifiedWarning', () => {
    it('lists only the provided missing fields in the tooltip', () => {
        const { title, child } = tooltipChild(UnclarifiedWarning({ missingLabels: ['energy', 'work context'] }));
        expect(title).toBe('Not fully clarified — missing: energy, work context');
        if (!child) throw new Error('expected an icon child inside the Tooltip');
        expect(child.props).toMatchObject({ fontSize: 'small', color: 'warning', 'data-testid': 'unclarifiedWarning' });
    });
});
