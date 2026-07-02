import { describe, expect, it } from 'vitest';
import { sortByName } from '../lib/sortByName';

const named = (names: string[]) => names.map((name, i) => ({ _id: `id-${i}`, name }));

describe('sortByName', () => {
    it('sorts alphabetically, case-insensitively', () => {
        const sorted = sortByName(named(['charlie', 'Alpha', 'beta']));
        expect(sorted.map((e) => e.name)).toEqual(['Alpha', 'beta', 'charlie']);
    });

    it('does not mutate the input array', () => {
        const input = named(['b', 'a']);
        const sorted = sortByName(input);
        expect(input.map((e) => e.name)).toEqual(['b', 'a']);
        expect(sorted).not.toBe(input);
    });

    it('keeps entities that differ only by case adjacent without dropping either', () => {
        // sensitivity: 'base' treats 'dana' and 'Dana' as equal — both must survive the sort.
        const sorted = sortByName(named(['dana', 'Dana', 'Ann']));
        expect(sorted).toHaveLength(3);
        expect(sorted[0]?.name).toBe('Ann');
    });

    it('handles the empty array', () => {
        expect(sortByName([])).toEqual([]);
    });
});
