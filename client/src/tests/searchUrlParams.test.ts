import { describe, expect, it } from 'vitest';
import { ACTIVE_STATUSES } from '../lib/itemSearch';
import { DEFAULT_URL_STATE, isDateField, parseSearchParams, urlStateToFilters } from '../lib/searchUrlParams';

describe('parseSearchParams', () => {
    it('returns DEFAULT_URL_STATE for an empty bag', () => {
        expect(parseSearchParams({})).toEqual(DEFAULT_URL_STATE);
    });

    it('reads a typical URL bag', () => {
        const result = parseSearchParams({
            q: 'milk',
            statuses: 'inbox,nextAction',
            personId: 'p1',
            contextId: 'c1',
            dateField: 'createdTs',
            dateFrom: '2026-01-01',
            dateTo: '2026-04-01',
            view: 'table',
        });
        expect(result).toEqual({
            q: 'milk',
            statuses: ['inbox', 'nextAction'],
            personId: 'p1',
            contextId: 'c1',
            dateField: 'createdTs',
            dateFrom: '2026-01-01',
            dateTo: '2026-04-01',
            view: 'table',
        });
    });

    it('rejects malformed dates', () => {
        const result = parseSearchParams({ dateFrom: 'not-a-date', dateTo: '2026-13-01' });
        expect(result.dateFrom).toBeNull();
        expect(result.dateTo).toBeNull();
    });

    it('preserves only valid statuses from a mixed list', () => {
        expect(parseSearchParams({ statuses: 'inbox,bogus,done' }).statuses).toEqual(['inbox', 'done']);
    });

    it('falls back to null statuses when every value is invalid', () => {
        expect(parseSearchParams({ statuses: 'bogus,also-bogus' }).statuses).toBeNull();
    });

    it('falls back to default dateField when unknown', () => {
        expect(parseSearchParams({ dateField: 'somethingElse' }).dateField).toBe('updatedTs');
    });

    it('falls back to default view when unknown', () => {
        expect(parseSearchParams({ view: 'gallery' }).view).toBe('grouped');
    });

    it('ignores non-string values', () => {
        // Hostile inputs simulating a manually-edited URL or stale link
        const result = parseSearchParams({ q: 42 as unknown, view: null as unknown });
        expect(result.q).toBe('');
        expect(result.view).toBe('grouped');
    });

    it('accepts statuses as an array (from TanStack Router JSON-decoded values)', () => {
        // TanStack Router JSON-parses search params, so a written array round-trips back as an array.
        expect(parseSearchParams({ statuses: ['inbox', 'nextAction'] as unknown }).statuses).toEqual(['inbox', 'nextAction']);
    });

    it('preserves an explicit empty statuses array as "match nothing"', () => {
        // Empty array is the user's deliberate "show nothing" state — must not silently fall back to defaults.
        expect(parseSearchParams({ statuses: [] as unknown }).statuses).toEqual([]);
    });

    it('drops invalid entries from a statuses array', () => {
        expect(parseSearchParams({ statuses: ['inbox', 'bogus', 42, 'done'] as unknown }).statuses).toEqual(['inbox', 'done']);
    });
});

describe('urlStateToFilters', () => {
    it('substitutes the active-statuses default when state.statuses is null', () => {
        const filters = urlStateToFilters(DEFAULT_URL_STATE);
        expect([...filters.statuses].sort()).toEqual([...ACTIVE_STATUSES].sort());
    });

    it('uses the explicit status set when state.statuses is non-null', () => {
        const filters = urlStateToFilters({ ...DEFAULT_URL_STATE, statuses: ['done'] });
        expect([...filters.statuses]).toEqual(['done']);
    });

    it('produces an empty status set when state.statuses is []', () => {
        // [] is the user's deliberate "match nothing" state — must not silently fall back to defaults.
        const filters = urlStateToFilters({ ...DEFAULT_URL_STATE, statuses: [] });
        expect(filters.statuses.size).toBe(0);
    });

    it('passes through query/personId/contextId/date fields verbatim', () => {
        const state = { ...DEFAULT_URL_STATE, q: 'foo', personId: 'p1', contextId: 'c1', dateFrom: '2026-01-01', dateTo: '2026-02-01' };
        const filters = urlStateToFilters(state);
        expect(filters.query).toBe('foo');
        expect(filters.personId).toBe('p1');
        expect(filters.contextId).toBe('c1');
        expect(filters.dateFrom).toBe('2026-01-01');
        expect(filters.dateTo).toBe('2026-02-01');
    });
});

describe('isDateField', () => {
    it('accepts the two valid values', () => {
        expect(isDateField('updatedTs')).toBe(true);
        expect(isDateField('createdTs')).toBe(true);
    });

    it('rejects everything else', () => {
        expect(isDateField('updated')).toBe(false);
        expect(isDateField('')).toBe(false);
    });
});
