import { describe, expect, it } from 'vitest';
import { hasAtLeastOne } from '../lib/typeUtils';

describe('hasAtLeastOne', () => {
    it('returns true for an array with one element', () => {
        expect(hasAtLeastOne([1])).toBe(true);
    });

    it('returns true for an array with multiple elements', () => {
        expect(hasAtLeastOne([1, 2, 3])).toBe(true);
    });

    it('returns false for an empty array', () => {
        expect(hasAtLeastOne([])).toBe(false);
    });

    it('narrows the type so arr[0] is T, not T | undefined', () => {
        const arr: number[] = [42];
        if (hasAtLeastOne(arr)) {
            const first: number = arr[0]; // would fail tsc if guard is wrong
            expect(first).toBe(42);
        }
    });
});
