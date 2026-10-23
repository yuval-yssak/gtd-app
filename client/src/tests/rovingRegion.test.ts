import { describe, expect, it } from 'vitest';
import { nextRegionIndex, nextRovingIndex } from '../lib/rovingRegion';

describe('nextRovingIndex', () => {
    it('a vertical menu walks with ↑/↓ only, clamping at both ends', () => {
        expect(nextRovingIndex(4, 1, 'ArrowDown', 'vertical')).toBe(2);
        expect(nextRovingIndex(4, 1, 'ArrowUp', 'vertical')).toBe(0);
        expect(nextRovingIndex(4, 0, 'ArrowUp', 'vertical')).toBe(0);
        expect(nextRovingIndex(4, 3, 'ArrowDown', 'vertical')).toBe(3);
        expect(nextRovingIndex(4, 1, 'ArrowRight', 'vertical')).toBeNull();
    });

    it('a horizontal toolbar walks with ←/→; a chip cloud with all four arrows', () => {
        expect(nextRovingIndex(3, 0, 'ArrowRight', 'horizontal')).toBe(1);
        expect(nextRovingIndex(3, 0, 'ArrowDown', 'horizontal')).toBeNull();
        expect(nextRovingIndex(3, 1, 'ArrowDown', 'both')).toBe(2);
        expect(nextRovingIndex(3, 1, 'ArrowLeft', 'both')).toBe(0);
    });

    it('Home and End jump to the ends; other keys and empty regions do nothing', () => {
        expect(nextRovingIndex(5, 2, 'Home', 'vertical')).toBe(0);
        expect(nextRovingIndex(5, 2, 'End', 'horizontal')).toBe(4);
        expect(nextRovingIndex(5, 2, 'Enter', 'both')).toBeNull();
        expect(nextRovingIndex(0, 0, 'ArrowDown', 'vertical')).toBeNull();
    });
});

describe('nextRovingIndex from the container (current = -1)', () => {
    it('a next key or Home steps onto the first item, a previous key or End onto the last; other keys do nothing', () => {
        expect(nextRovingIndex(4, -1, 'ArrowDown', 'vertical')).toBe(0);
        expect(nextRovingIndex(4, -1, 'ArrowUp', 'vertical')).toBe(3);
        expect(nextRovingIndex(4, -1, 'ArrowLeft', 'horizontal')).toBe(3);
        expect(nextRovingIndex(4, -1, 'Home', 'vertical')).toBe(0);
        expect(nextRovingIndex(4, -1, 'End', 'vertical')).toBe(3);
        expect(nextRovingIndex(4, -1, 'ArrowRight', 'vertical')).toBeNull();
    });
});

describe('nextRegionIndex', () => {
    it('cycles forward and back, wrapping; from outside every region F6 lands on the first and Shift+F6 on the last', () => {
        expect(nextRegionIndex(3, 0, 1)).toBe(1);
        expect(nextRegionIndex(3, 2, 1)).toBe(0);
        expect(nextRegionIndex(3, 0, -1)).toBe(2);
        expect(nextRegionIndex(3, -1, 1)).toBe(0);
        expect(nextRegionIndex(3, -1, -1)).toBe(2);
        expect(nextRegionIndex(0, -1, 1)).toBeNull();
    });
});
