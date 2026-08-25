import { describe, expect, it } from 'vitest';
import { flattenByPersonGroups, groupByWaitingForPerson, resolvePersonName, sortGroupEntriesByPersonName, UNASSIGNED_GROUP_KEY } from '../lib/waitingForGroups';
import type { StoredItem } from '../types/MyDB';

const mkItem = (overrides: Partial<StoredItem> & { _id: string }): StoredItem => ({
    userId: 'u1',
    title: 'untitled',
    status: 'waitingFor',
    createdTs: '2026-01-01T00:00:00.000Z',
    updatedTs: '2026-01-01T00:00:00.000Z',
    ...overrides,
});

describe('groupByWaitingForPerson', () => {
    it('groups items under their waitingForPersonId', () => {
        const items = [
            mkItem({ _id: '1', waitingForPersonId: 'p1' }),
            mkItem({ _id: '2', waitingForPersonId: 'p1' }),
            mkItem({ _id: '3', waitingForPersonId: 'p2' }),
        ];
        const groups = groupByWaitingForPerson(items);
        // biome-ignore lint/complexity/useLiteralKeys: TS requires bracket notation for index signature
        expect(groups['p1']?.map((i) => i._id)).toEqual(['1', '2']);
        // biome-ignore lint/complexity/useLiteralKeys: TS requires bracket notation for index signature
        expect(groups['p2']?.map((i) => i._id)).toEqual(['3']);
    });

    it('buckets items with no person under the unassigned key', () => {
        const items = [mkItem({ _id: '1' })];
        const groups = groupByWaitingForPerson(items);
        expect(groups[UNASSIGNED_GROUP_KEY]?.map((i) => i._id)).toEqual(['1']);
    });
});

describe('flattenByPersonGroups', () => {
    it('flattens in group order (A→Z, Unassigned last), keeping the input item order within each group', () => {
        const items = [
            mkItem({ _id: 'zoe1', waitingForPersonId: 'p-zoe' }),
            mkItem({ _id: 'none1' }),
            mkItem({ _id: 'alice1', waitingForPersonId: 'p-alice' }),
            mkItem({ _id: 'zoe2', waitingForPersonId: 'p-zoe' }),
        ];
        const flat = flattenByPersonGroups(items, { 'p-zoe': 'Zoe', 'p-alice': 'Alice' });
        expect(flat.map((i) => i._id)).toEqual(['alice1', 'zoe1', 'zoe2', 'none1']);
    });

    it('resolves an unknown person id to "Unknown" for ordering and does not mutate its input', () => {
        const items = [mkItem({ _id: 'mystery', waitingForPersonId: 'p-gone' }), mkItem({ _id: 'bob1', waitingForPersonId: 'p-bob' })];
        const inputOrder = items.map((i) => i._id);
        // "Bob" < "Unknown" alphabetically, so the resolvable group leads.
        expect(flattenByPersonGroups(items, { 'p-bob': 'Bob' }).map((i) => i._id)).toEqual(['bob1', 'mystery']);
        expect(items.map((i) => i._id)).toEqual(inputOrder);
    });
});

describe('resolvePersonName', () => {
    it('returns the mapped name when the person id is known', () => {
        expect(resolvePersonName({ p1: 'Alice' }, 'p1')).toBe('Alice');
    });

    it('falls back to "Unknown" for an id missing from the map', () => {
        expect(resolvePersonName({ p1: 'Alice' }, 'p2')).toBe('Unknown');
    });

    it('falls back to "Unknown" when the map is empty', () => {
        expect(resolvePersonName({}, 'p1')).toBe('Unknown');
    });
});

describe('sortGroupEntriesByPersonName', () => {
    it('orders groups alphabetically by resolved person name', () => {
        const groups = { p1: [mkItem({ _id: '1', waitingForPersonId: 'p1' })], p2: [mkItem({ _id: '2', waitingForPersonId: 'p2' })] };
        const personMap = { p1: 'Zoe', p2: 'Alice' };
        expect(sortGroupEntriesByPersonName(groups, personMap).map(([id]) => id)).toEqual(['p2', 'p1']);
    });

    it('sorts case-insensitively', () => {
        const groups = { p1: [mkItem({ _id: '1', waitingForPersonId: 'p1' })], p2: [mkItem({ _id: '2', waitingForPersonId: 'p2' })] };
        const personMap = { p1: 'bob', p2: 'Alice' };
        expect(sortGroupEntriesByPersonName(groups, personMap).map(([id]) => id)).toEqual(['p2', 'p1']);
    });

    it('always sorts the unassigned bucket last, regardless of name comparisons', () => {
        const groups = {
            [UNASSIGNED_GROUP_KEY]: [mkItem({ _id: '1' })],
            p1: [mkItem({ _id: '2', waitingForPersonId: 'p1' })],
        };
        const personMap = { p1: 'Alice' };
        expect(sortGroupEntriesByPersonName(groups, personMap).map(([id]) => id)).toEqual(['p1', UNASSIGNED_GROUP_KEY]);
    });

    it('falls back to "Unknown" for a person id missing from the map', () => {
        const groups = { p1: [mkItem({ _id: '1', waitingForPersonId: 'p1' })], p2: [mkItem({ _id: '2', waitingForPersonId: 'p2' })] };
        const personMap = { p1: 'Alice' };
        // "Alice" < "Unknown" alphabetically, so p1 stays first even though p2 has no resolvable name.
        expect(sortGroupEntriesByPersonName(groups, personMap).map(([id]) => id)).toEqual(['p1', 'p2']);
    });
});
