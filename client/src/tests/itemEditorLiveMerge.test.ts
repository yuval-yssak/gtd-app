import { describe, expect, it } from 'vitest';
import { itemToFormSeeds, mergeFormGroup, mergeItemForms } from '../components/itemEditor/itemEditorLiveMerge';
import type { StoredItem } from '../types/MyDB';

function makeItem(overrides: Partial<StoredItem> = {}): StoredItem {
    return {
        _id: 'item-1',
        userId: 'user-1',
        status: 'nextAction',
        title: 'Original title',
        createdTs: '2026-07-01T10:00:00.000Z',
        updatedTs: '2026-07-01T10:00:00.000Z',
        energy: 'low',
        workContextIds: ['ctx-1'],
        ...overrides,
    };
}

describe('itemToFormSeeds', () => {
    it('seeds every form group from the item', () => {
        const seeds = itemToFormSeeds(makeItem({ notes: 'note', time: 15, expectedBy: '2026-07-10' }));
        expect(seeds.title).toBe('Original title');
        expect(seeds.notes).toBe('note');
        expect(seeds.status).toBe('nextAction');
        expect(seeds.na.energy).toBe('low');
        expect(seeds.na.time).toBe('15');
        expect(seeds.na.workContextIds).toEqual(['ctx-1']);
        expect(seeds.sm.expectedBy).toBe('2026-07-10');
        // WaitingFor never re-seeds a hidden tickler date.
        expect(seeds.wf.ignoreBefore).toBe('');
    });
});

describe('mergeFormGroup', () => {
    it('adopts incoming values for clean keys, including arrays compared by value', () => {
        const seed = { ids: ['a'], flag: false };
        const form = { ids: ['a'], flag: true }; // ids clean (value-equal fresh array), flag dirty
        const incoming = { ids: ['a', 'b'], flag: false };

        const { merged, conflicts } = mergeFormGroup(form, seed, incoming, { ids: 'IDs', flag: 'Flag' });
        expect(merged.ids).toEqual(['a', 'b']); // clean → adopted
        expect(merged.flag).toBe(true); // dirty → local kept
        expect(conflicts).toEqual([]); // incoming.flag === seed.flag → no conflict
    });

    it('flags a conflict when both sides changed a key to different values', () => {
        const seed = { energy: 'low' };
        const form = { energy: 'high' };
        const incoming = { energy: 'medium' };
        expect(mergeFormGroup(form, seed, incoming, { energy: 'Energy' }).conflicts).toEqual(['Energy']);
    });

    it('does not flag when both sides made the same change', () => {
        const seed = { energy: 'low' };
        const form = { energy: 'high' };
        const incoming = { energy: 'high' };
        expect(mergeFormGroup(form, seed, incoming, { energy: 'Energy' }).conflicts).toEqual([]);
    });
});

describe('mergeItemForms', () => {
    it('adopts a remote title into a clean form and reports no conflict', () => {
        const item = makeItem();
        const seed = itemToFormSeeds(item);
        const incoming = itemToFormSeeds(makeItem({ title: 'Renamed remotely', updatedTs: '2026-07-01T11:00:00.000Z' }));

        const { merged, conflicts } = mergeItemForms(seed, seed, incoming);
        expect(merged.title).toBe('Renamed remotely');
        expect(conflicts).toEqual([]);
    });

    it('keeps a dirty status and reports the conflict when remote also changed it', () => {
        const item = makeItem();
        const seed = itemToFormSeeds(item);
        const form = { ...seed, status: 'waitingFor' as const }; // user picked a chip
        const incoming = itemToFormSeeds(makeItem({ status: 'somedayMaybe', updatedTs: '2026-07-01T11:00:00.000Z' }));

        const { merged, conflicts } = mergeItemForms(form, seed, incoming);
        expect(merged.status).toBe('waitingFor'); // local wins
        expect(conflicts).toContain('Status');
    });

    it('suppresses conflicts on form groups the current status does not render', () => {
        const item = makeItem({ status: 'nextAction' });
        const seed = itemToFormSeeds(item);
        // User dirtied the (hidden) calendar form; remote changed calendar fields differently.
        const form = { ...seed, cal: { ...seed.cal, date: '2026-07-20' } };
        const incoming = itemToFormSeeds(
            makeItem({
                status: 'nextAction',
                timeStart: '2026-07-25T09:00:00.000Z',
                timeEnd: '2026-07-25T10:00:00.000Z',
                updatedTs: '2026-07-01T11:00:00.000Z',
            }),
        );

        const { conflicts } = mergeItemForms(form, seed, incoming);
        expect(conflicts).toEqual([]); // calendar group is hidden for nextAction — noise, not a conflict
    });

    it('reports conflicts on the active group (nextAction energy)', () => {
        const item = makeItem({ energy: 'low' });
        const seed = itemToFormSeeds(item);
        const form = { ...seed, na: { ...seed.na, energy: 'high' as const } };
        const incoming = itemToFormSeeds(makeItem({ energy: 'medium', updatedTs: '2026-07-01T11:00:00.000Z' }));

        const { merged, conflicts } = mergeItemForms(form, seed, incoming);
        expect(merged.na.energy).toBe('high');
        expect(conflicts).toEqual(['Energy']);
    });
});
