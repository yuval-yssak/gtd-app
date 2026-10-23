import { describe, expect, it } from 'vitest';
import { isStrictlyIncreasing } from '../lib/itemRank.js';
import { mintImportRanks } from '../scripts/importFacileThings.js';

describe('importFacileThings — rank minting', () => {
    it("mints every row ONCE for the run, in file order, above the user's existing keys", () => {
        const ranks = mintImportRanks('a0', 5);
        expect(ranks).toHaveLength(5);
        expect(isStrictlyIncreasing(ranks)).toBe(true);
        expect(ranks.every((rank) => rank < 'a0')).toBe(true);
    });

    it('starts at the origin for a user with no ranked rows, and slicing per batch keeps the file order', () => {
        const ranks = mintImportRanks(null, 2500);
        expect(ranks[0]).toBe('a0');
        const batches = [ranks.slice(0, 1000), ranks.slice(1000, 2000), ranks.slice(2000)];
        expect(isStrictlyIncreasing(batches.flat())).toBe(true);
    });
});
