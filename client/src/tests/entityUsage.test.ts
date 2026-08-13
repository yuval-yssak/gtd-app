import { describe, expect, it } from 'vitest';
import { buildUsageIndex, EMPTY_USAGE_INDEX, omitArchived, rankByUsage, rankMergedOptionsByUsage } from '../lib/entityUsage';
import type { MergedFilterOption } from '../lib/mergedFilterOptions';
import type { StoredItem } from '../types/MyDB';

function makeItem(overrides: Partial<StoredItem>): StoredItem {
    return {
        _id: crypto.randomUUID(),
        userId: 'u1',
        status: 'nextAction',
        title: 'x',
        createdTs: '2026-08-01T00:00:00.000Z',
        updatedTs: '2026-08-01T00:00:00.000Z',
        ...overrides,
    };
}

describe('buildUsageIndex', () => {
    it('counts context and people references and tracks the latest referencing updatedTs', () => {
        const items = [
            makeItem({ workContextIds: ['c1', 'c2'], peopleIds: ['p1'], updatedTs: '2026-08-01T00:00:00.000Z' }),
            makeItem({ workContextIds: ['c1'], updatedTs: '2026-08-05T00:00:00.000Z' }),
        ];
        const usage = buildUsageIndex(items);
        expect(usage.contexts.get('c1')).toEqual({ count: 2, lastUsedTs: '2026-08-05T00:00:00.000Z' });
        expect(usage.contexts.get('c2')).toEqual({ count: 1, lastUsedTs: '2026-08-01T00:00:00.000Z' });
        expect(usage.people.get('p1')).toEqual({ count: 1, lastUsedTs: '2026-08-01T00:00:00.000Z' });
    });

    it('counts waitingForPersonId as person usage', () => {
        const usage = buildUsageIndex([makeItem({ status: 'waitingFor', waitingForPersonId: 'p9' })]);
        expect(usage.people.get('p9')?.count).toBe(1);
    });

    it('ignores trashed items but counts done items', () => {
        const items = [makeItem({ status: 'trash', workContextIds: ['c1'] }), makeItem({ status: 'done', workContextIds: ['c2'] })];
        const usage = buildUsageIndex(items);
        expect(usage.contexts.get('c1')).toBeUndefined();
        expect(usage.contexts.get('c2')?.count).toBe(1);
    });
});

describe('rankByUsage', () => {
    const contexts = [
        { _id: 'a', name: 'Alpha' },
        { _id: 'b', name: 'Beta' },
        { _id: 'c', name: 'Gamma' },
    ];

    it('sorts by count desc, then recency desc, then name', () => {
        const usage = new Map([
            ['b', { count: 2, lastUsedTs: '2026-08-01T00:00:00.000Z' }],
            ['c', { count: 1, lastUsedTs: '2026-08-06T00:00:00.000Z' }],
            ['a', { count: 1, lastUsedTs: '2026-08-02T00:00:00.000Z' }],
        ]);
        expect(rankByUsage(contexts, usage).map((c) => c._id)).toEqual(['b', 'c', 'a']);
    });

    it('falls back to alphabetical when nothing is used', () => {
        expect(rankByUsage(contexts, EMPTY_USAGE_INDEX.contexts).map((c) => c._id)).toEqual(['a', 'b', 'c']);
    });
});

describe('rankMergedOptionsByUsage', () => {
    it('combines twin usage: sums counts across accounts', () => {
        const options: MergedFilterOption[] = [
            { canonicalId: 'x1', name: 'agenda', ids: ['x1', 'x2'] },
            { canonicalId: 'y1', name: 'office', ids: ['y1'] },
        ];
        const usage = new Map([
            ['x1', { count: 1, lastUsedTs: '2026-08-01T00:00:00.000Z' }],
            ['x2', { count: 1, lastUsedTs: '2026-08-02T00:00:00.000Z' }],
            ['y1', { count: 1, lastUsedTs: '2026-08-09T00:00:00.000Z' }],
        ]);
        // agenda: 2 uses across twins beats office's single (more recent) use.
        expect(rankMergedOptionsByUsage(options, usage).map((o) => o.name)).toEqual(['agenda', 'office']);
    });
});

describe('omitArchived', () => {
    const pool = [
        { _id: 'a', name: 'active' },
        { _id: 'b', name: 'archived', archived: true },
        { _id: 'c', name: 'archived-but-assigned', archived: true },
    ];

    it('drops archived entities', () => {
        expect(omitArchived(pool).map((e) => e._id)).toEqual(['a']);
    });

    it('keeps archived entities whose id is in keepIds (selected/assigned)', () => {
        expect(omitArchived(pool, new Set(['c'])).map((e) => e._id)).toEqual(['a', 'c']);
    });
});
