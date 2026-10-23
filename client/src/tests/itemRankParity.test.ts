/**
 * PARITY FIXTURES — the api-server test (`api-server/src/tests/itemRankParity.test.ts`) asserts the identical
 * table against its mirror of `lib/itemRank.ts`. A divergence between the two means a key minted on
 * one side would sort differently on the other. Change both files together.
 */
import { describe, expect, it } from 'vitest';
import {
    compareRank,
    evenlySpacedRanks,
    isRankTooLong,
    isStrictlyIncreasing,
    isValidRank,
    RANK_TOO_LONG_THRESHOLD,
    rankAt,
    rankBetween,
    ranksBetween,
    topRank,
    topRanks,
} from '../lib/itemRank';

const BETWEEN_FIXTURE: ReadonlyArray<readonly [above: string | null, below: string | null, expected: string]> = [
    [null, null, 'a0'],
    [null, 'a0', 'Zz'],
    [null, 'Zz', 'Zy'],
    ['a0', null, 'a1'],
    ['a1', null, 'a2'],
    ['a0', 'a1', 'a0V'],
    ['a0', 'a0V', 'a0G'],
    ['a0V', 'a1', 'a0l'],
    ['Zy', 'Zz', 'ZyV'],
    // Code-unit order: uppercase sorts before lowercase, so `Zz` < `a0` and a key fits between.
    ['Zz', 'a0', 'ZzV'],
];

const COMPARE_FIXTURE: ReadonlyArray<readonly [a: string, b: string, expected: -1 | 0 | 1]> = [
    ['Zz', 'a0', -1],
    ['a0', 'Zz', 1],
    ['a0', 'a0', 0],
    ['a0', 'a0V', -1],
    ['B0', 'a0', -1],
    ['9z', 'A0', -1],
];

describe('itemRank parity', () => {
    it.each(BETWEEN_FIXTURE)('rankBetween(%j, %j) === %s', (above, below, expected) => {
        expect(rankBetween(above, below)).toBe(expected);
    });

    it.each(COMPARE_FIXTURE)('compareRank(%s, %s) === %d', (a, b, expected) => {
        expect(compareRank(a, b)).toBe(expected);
    });

    it('topRank mints below the lowest existing key and starts at the origin', () => {
        expect(topRank(undefined)).toBe('a0');
        expect(topRank('a0')).toBe('Zz');
        expect(topRank('Zz')).toBe('Zy');
        expect(compareRank(topRank('a0V'), 'a0V')).toBe(-1);
    });

    it('topRanks yields n strictly increasing keys all below the existing minimum', () => {
        expect(topRanks('a0', 3)).toEqual(['Zx', 'Zy', 'Zz']);
        expect(topRanks(null, 2)).toEqual(['a0', 'a1']);
        expect(topRanks('a0', 100).every((rank) => compareRank(rank, 'a0') < 0)).toBe(true);
    });

    it('ranksBetween yields n strictly increasing keys inside the bounds', () => {
        expect(ranksBetween('a0', 'a1', 2)).toEqual(['a0G', 'a0V']);
        expect(ranksBetween(null, 'a0', 1)).toEqual(['Zz']);
        expect(ranksBetween('a1', null, 2)).toEqual(['a2', 'a3']);
    });

    it('rankAt returns the key at an index and throws past the end', () => {
        expect(rankAt(['a0', 'a1'], 1)).toBe('a1');
        expect(() => rankAt(['a0'], 1)).toThrow();
    });

    it('evenlySpacedRanks yields n strictly increasing keys', () => {
        expect(evenlySpacedRanks(3)).toEqual(['a0', 'a1', 'a2']);
        expect(evenlySpacedRanks(0)).toEqual([]);
        const many = evenlySpacedRanks(200);
        expect(many).toHaveLength(200);
        expect(isStrictlyIncreasing(many)).toBe(true);
    });

    it('rankBetween throws on equal neighbours, and an inverted pair yields a key that is not between them — callers must re-key first', () => {
        expect(() => rankBetween('a0', 'a0')).toThrow();
        const key = rankBetween('a1', 'a0');
        expect(compareRank('a1', key) < 0 && compareRank(key, 'a0') < 0).toBe(false);
    });

    it('treats undefined like null (open end)', () => {
        expect(rankBetween(undefined, undefined)).toBe('a0');
        expect(rankBetween('a0', undefined)).toBe('a1');
    });

    it('isStrictlyIncreasing rejects equal and inverted neighbours', () => {
        expect(isStrictlyIncreasing([])).toBe(true);
        expect(isStrictlyIncreasing(['a0'])).toBe(true);
        expect(isStrictlyIncreasing(['Zz', 'a0', 'a0V'])).toBe(true);
        expect(isStrictlyIncreasing(['a0', 'a0'])).toBe(false);
        expect(isStrictlyIncreasing(['a1', 'a0'])).toBe(false);
    });

    it.each(['a0', 'Zz', 'a0V', 'ZzV', 'a1G'])('isValidRank accepts the minted key %s', (key) => {
        expect(isValidRank(key)).toBe(true);
    });

    it.each(['', '0', '!', 'A', 'x', 'a00', 'a0 ', 'é'])('isValidRank rejects the malformed key %j', (key) => {
        expect(isValidRank(key)).toBe(false);
    });

    it('isRankTooLong flips past the threshold', () => {
        expect(isRankTooLong('a'.repeat(RANK_TOO_LONG_THRESHOLD))).toBe(false);
        expect(isRankTooLong('a'.repeat(RANK_TOO_LONG_THRESHOLD + 1))).toBe(true);
    });
});
