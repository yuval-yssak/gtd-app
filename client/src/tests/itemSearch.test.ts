import { describe, expect, it } from 'vitest';
import { DEFAULT_SEARCH_FILTERS, filterItems, groupByStatus, sortItems } from '../lib/itemSearch';
import type { StoredItem } from '../types/MyDB';

const mkItem = (overrides: Partial<StoredItem> & { _id: string; status: StoredItem['status'] }): StoredItem => ({
    userId: 'u1',
    title: 'untitled',
    createdTs: '2026-01-01T00:00:00.000Z',
    updatedTs: '2026-01-01T00:00:00.000Z',
    ...overrides,
});

describe('filterItems', () => {
    it('matches title and notes case-insensitively', () => {
        const items = [
            mkItem({ _id: '1', status: 'inbox', title: 'Buy MILK' }),
            mkItem({ _id: '2', status: 'inbox', title: 'Other', notes: 'remember the milk' }),
            mkItem({ _id: '3', status: 'inbox', title: 'no match' }),
        ];
        const result = filterItems(items, { ...DEFAULT_SEARCH_FILTERS, query: 'milk' });
        expect(result.map((i) => i._id)).toEqual(['1', '2']);
    });

    it('excludes done and trash by default', () => {
        const items = [mkItem({ _id: '1', status: 'inbox' }), mkItem({ _id: '2', status: 'done' }), mkItem({ _id: '3', status: 'trash' })];
        const result = filterItems(items, DEFAULT_SEARCH_FILTERS);
        expect(result.map((i) => i._id)).toEqual(['1']);
    });

    it('respects an explicit status set', () => {
        const items = [mkItem({ _id: '1', status: 'inbox' }), mkItem({ _id: '2', status: 'done' })];
        const result = filterItems(items, { ...DEFAULT_SEARCH_FILTERS, statuses: new Set(['done']) });
        expect(result.map((i) => i._id)).toEqual(['2']);
    });

    it('filters by personId across peopleIds and waitingForPersonId', () => {
        const items = [
            mkItem({ _id: '1', status: 'nextAction', peopleIds: ['p1'] }),
            mkItem({ _id: '2', status: 'waitingFor', waitingForPersonId: 'p1' }),
            mkItem({ _id: '3', status: 'nextAction', peopleIds: ['p2'] }),
        ];
        const result = filterItems(items, { ...DEFAULT_SEARCH_FILTERS, personId: 'p1', statuses: new Set(['nextAction', 'waitingFor']) });
        expect(result.map((i) => i._id)).toEqual(['1', '2']);
    });

    it('filters by workContextId', () => {
        const items = [
            mkItem({ _id: '1', status: 'nextAction', workContextIds: ['c1', 'c2'] }),
            mkItem({ _id: '2', status: 'nextAction', workContextIds: ['c2'] }),
        ];
        const result = filterItems(items, { ...DEFAULT_SEARCH_FILTERS, contextId: 'c1' });
        expect(result.map((i) => i._id)).toEqual(['1']);
    });

    it('filters by date range on the chosen field, inclusive', () => {
        const items = [
            mkItem({ _id: '1', status: 'inbox', updatedTs: '2026-04-10T10:00:00.000Z' }),
            mkItem({ _id: '2', status: 'inbox', updatedTs: '2026-04-15T10:00:00.000Z' }),
            mkItem({ _id: '3', status: 'inbox', updatedTs: '2026-04-20T10:00:00.000Z' }),
        ];
        const result = filterItems(items, { ...DEFAULT_SEARCH_FILTERS, dateField: 'updatedTs', dateFrom: '2026-04-15', dateTo: '2026-04-20' });
        expect(result.map((i) => i._id)).toEqual(['2', '3']);
    });

    it('combines all filters with AND semantics', () => {
        const items = [
            mkItem({ _id: '1', status: 'nextAction', title: 'call', peopleIds: ['p1'], updatedTs: '2026-04-15T10:00:00.000Z' }),
            mkItem({ _id: '2', status: 'nextAction', title: 'call again', peopleIds: ['p2'], updatedTs: '2026-04-15T10:00:00.000Z' }),
            mkItem({ _id: '3', status: 'nextAction', title: 'unrelated', peopleIds: ['p1'], updatedTs: '2026-04-15T10:00:00.000Z' }),
        ];
        const result = filterItems(items, { ...DEFAULT_SEARCH_FILTERS, query: 'call', personId: 'p1' });
        expect(result.map((i) => i._id)).toEqual(['1']);
    });
});

describe('sortItems', () => {
    const items = [
        mkItem({ _id: 'a', status: 'inbox', createdTs: '2026-01-01T00:00:00.000Z', updatedTs: '2026-03-01T00:00:00.000Z' }),
        mkItem({ _id: 'b', status: 'inbox', createdTs: '2026-02-01T00:00:00.000Z', updatedTs: '2026-02-01T00:00:00.000Z' }),
    ];

    it('sorts by updatedTs desc (newest first)', () => {
        expect(sortItems(items, 'updatedTs', 'desc').map((i) => i._id)).toEqual(['a', 'b']);
    });

    it('sorts by createdTs asc (oldest first)', () => {
        expect(sortItems(items, 'createdTs', 'asc').map((i) => i._id)).toEqual(['a', 'b']);
    });

    it('does not mutate the input array', () => {
        const input = [...items];
        sortItems(input, 'createdTs', 'desc');
        expect(input.map((i) => i._id)).toEqual(['a', 'b']);
    });
});

describe('groupByStatus', () => {
    it('groups items by status and orders groups by canonical workflow order', () => {
        const items = [
            mkItem({ _id: '1', status: 'done' }),
            mkItem({ _id: '2', status: 'inbox' }),
            mkItem({ _id: '3', status: 'inbox' }),
            mkItem({ _id: '4', status: 'nextAction' }),
        ];
        const groups = groupByStatus(items);
        expect(groups.map((g) => g.status)).toEqual(['inbox', 'nextAction', 'done']);
        const inboxGroup = groups.find((g) => g.status === 'inbox');
        expect(inboxGroup?.items.map((i) => i._id)).toEqual(['2', '3']);
    });
});
