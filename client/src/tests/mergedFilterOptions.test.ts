import { describe, expect, it } from 'vitest';
import {
    filterOptionsToReferenced,
    type MergedFilterOption,
    mergeFilterOptionsByName,
    resolveSelectedFilterOption,
    sameNameIds,
} from '../lib/mergedFilterOptions';

const ctx = (_id: string, name: string) => ({ _id, name });

describe('mergeFilterOptionsByName', () => {
    it('returns no options for empty input', () => {
        expect(mergeFilterOptionsByName([])).toEqual([]);
    });

    it('collapses same-named entities across accounts into one option', () => {
        const merged = mergeFilterOptionsByName([ctx('b-agenda', 'agenda'), ctx('a-computer', 'computer'), ctx('a-agenda', 'agenda')]);
        expect(merged).toEqual([
            { canonicalId: 'a-agenda', name: 'agenda', ids: ['b-agenda', 'a-agenda'] },
            { canonicalId: 'a-computer', name: 'computer', ids: ['a-computer'] },
        ]);
    });

    it('groups names case-insensitively and ignores surrounding whitespace', () => {
        const merged = mergeFilterOptionsByName([ctx('x1', 'Agenda'), ctx('x2', ' agenda ')]);
        expect(merged).toHaveLength(1);
        const [group] = merged;
        if (!group) throw new Error('expected one merged group');
        expect(new Set(group.ids)).toEqual(new Set(['x1', 'x2']));
    });

    it('picks the lexicographically smallest id as canonical regardless of input order', () => {
        const forward = mergeFilterOptionsByName([ctx('id-1', 'agenda'), ctx('id-2', 'agenda')]);
        const reversed = mergeFilterOptionsByName([ctx('id-2', 'agenda'), ctx('id-1', 'agenda')]);
        expect(forward[0]?.canonicalId).toBe('id-1');
        expect(reversed[0]?.canonicalId).toBe('id-1');
    });

    it('labels the merged option from the canonical twin, not sort position', () => {
        const merged = mergeFilterOptionsByName([ctx('z-id', 'AGENDA'), ctx('a-id', 'agenda')]);
        const [group] = merged;
        if (!group) throw new Error('expected one merged group');
        expect(group.canonicalId).toBe('a-id');
        expect(group.name).toBe('agenda');
    });

    it('does not render leading/trailing whitespace in the label', () => {
        const [group] = mergeFilterOptionsByName([ctx('1', ' agenda'), ctx('2', 'Agenda')]);
        if (!group) throw new Error('expected one merged group');
        expect(group.name).toBe('agenda');
    });

    it('sorts options alphabetically by name', () => {
        const merged = mergeFilterOptionsByName([ctx('1', 'phone'), ctx('2', 'Agenda'), ctx('3', 'computer')]);
        expect(merged.map((option) => option.name)).toEqual(['Agenda', 'computer', 'phone']);
    });

    it('passes single-account options through one-to-one', () => {
        const merged = mergeFilterOptionsByName([ctx('c1', 'agenda'), ctx('c2', 'computer')]);
        expect(merged).toEqual([
            { canonicalId: 'c1', name: 'agenda', ids: ['c1'] },
            { canonicalId: 'c2', name: 'computer', ids: ['c2'] },
        ]);
    });
});

describe('resolveSelectedFilterOption', () => {
    const all = [ctx('a-agenda', 'agenda'), ctx('b-agenda', 'agenda'), ctx('a-solo', 'solo')];
    const merged = mergeFilterOptionsByName(all);

    it('returns undefined when no filter is set', () => {
        expect(resolveSelectedFilterOption(undefined, merged, all)).toBeUndefined();
    });

    it('resolves a canonical id to its merged option and full id group', () => {
        const selected = resolveSelectedFilterOption('a-agenda', merged, all);
        expect(selected?.option?.canonicalId).toBe('a-agenda');
        expect(selected?.ids).toEqual(new Set(['a-agenda', 'b-agenda']));
    });

    it('resolves a non-canonical twin id to the same option (deep link from the other account)', () => {
        const selected = resolveSelectedFilterOption('b-agenda', merged, all);
        expect(selected?.option?.canonicalId).toBe('a-agenda');
        expect(selected?.ids).toEqual(new Set(['a-agenda', 'b-agenda']));
    });

    it('re-attaches a hidden account twin id to the visible same-name option by name', () => {
        // Account B hidden: its "agenda" is absent from the merged (visible) options but still
        // present in the unfiltered all* set. The chip must stay active and match visible twins.
        const visibleMerged = mergeFilterOptionsByName([ctx('a-agenda', 'agenda'), ctx('a-solo', 'solo')]);
        const selected = resolveSelectedFilterOption('b-agenda', visibleMerged, all);
        expect(selected?.option?.canonicalId).toBe('a-agenda');
        expect(selected?.ids).toEqual(new Set(['a-agenda', 'b-agenda']));
    });

    it('falls back to a singleton set with no active option for an id unknown even to all*', () => {
        const selected = resolveSelectedFilterOption('gone', merged, all);
        expect(selected?.option).toBeUndefined();
        expect(selected?.ids).toEqual(new Set(['gone']));
    });
});

describe('sameNameIds', () => {
    const all = [
        { _id: 'a1', name: 'agenda' },
        { _id: 'a2', name: 'Agenda ' },
        { _id: 'b1', name: 'office' },
    ];

    it('returns the whole case/whitespace-insensitive twin group of the given id', () => {
        expect([...sameNameIds('a1', all)].sort()).toEqual(['a1', 'a2']);
    });

    it('falls back to a singleton for an unknown id and empty for none', () => {
        expect([...sameNameIds('ghost', all)]).toEqual(['ghost']);
        expect(sameNameIds(undefined, all).size).toBe(0);
    });
});

describe('filterOptionsToReferenced', () => {
    const options: MergedFilterOption[] = [
        { canonicalId: 'a1', name: 'agenda', ids: ['a1', 'a2'] },
        { canonicalId: 'b1', name: 'office', ids: ['b1'] },
        { canonicalId: 'c1', name: 'phone', ids: ['c1'] },
    ];

    it('keeps only options with at least one referenced id', () => {
        const live = filterOptionsToReferenced(options, new Set(['a2']), undefined);
        expect(live.map((o) => o.name)).toEqual(['agenda']);
    });

    it('always keeps the selected option, even with zero references', () => {
        const selected = options[2];
        if (!selected) throw new Error('expected the phone option');
        const live = filterOptionsToReferenced(options, new Set(['b1']), selected);
        expect(live.map((o) => o.name)).toEqual(['office', 'phone']);
    });
});
