import { describe, expect, it } from 'vitest';
import { SKELETON_ROW_WIDTHS, shouldRaiseInitialSync, skeletonRowWidth } from '../lib/syncIndicators';

describe('shouldRaiseInitialSync', () => {
    it('raises the skeleton only on the first online bootstrap (no cursor yet)', () => {
        expect(shouldRaiseInitialSync({ isOnline: true, hasCursor: false })).toBe(true);
    });

    it('does not raise for a returning device that already has a cursor', () => {
        expect(shouldRaiseInitialSync({ isOnline: true, hasCursor: true })).toBe(false);
    });

    it('does not raise while offline — there is no bootstrap to wait for', () => {
        expect(shouldRaiseInitialSync({ isOnline: false, hasCursor: false })).toBe(false);
        expect(shouldRaiseInitialSync({ isOnline: false, hasCursor: true })).toBe(false);
    });
});

describe('skeletonRowWidth', () => {
    it('cycles through the fixed widths by row index', () => {
        SKELETON_ROW_WIDTHS.forEach((width, i) => {
            expect(skeletonRowWidth(i)).toBe(width);
        });
    });

    it('wraps deterministically past the array length (no reshuffle on re-render)', () => {
        const len = SKELETON_ROW_WIDTHS.length;
        expect(skeletonRowWidth(len)).toBe(skeletonRowWidth(0));
        expect(skeletonRowWidth(len + 2)).toBe(skeletonRowWidth(2));
        // Same index always yields the same width — the property the comment promises.
        expect(skeletonRowWidth(3)).toBe(skeletonRowWidth(3));
    });
});
