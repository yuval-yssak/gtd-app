import { describe, expect, it } from 'vitest';
import { createSwipeTracker } from '../lib/swipeTracker';

describe('createSwipeTracker', () => {
    it.each([
        { from: 100, to: 200, outcome: 'right' },
        { from: 200, to: 100, outcome: 'left' },
        { from: 100, to: 105, outcome: 'tap' },
        { from: 100, to: 140, outcome: 'short' },
    ] as const)('a swipe from $from to $to ends as $outcome', ({ from, to, outcome }) => {
        const tracker = createSwipeTracker(80);
        tracker.start(from);
        tracker.move(to);
        expect(tracker.end()).toBe(outcome);
    });

    it('clamps the offset the row slides', () => {
        const tracker = createSwipeTracker(80);
        tracker.start(300);
        expect(tracker.move(0)).toBe(-120);
    });

    it('ignores a move and end with no start of their own, even after an earlier gesture (the handle drag that trashed a row)', () => {
        const tracker = createSwipeTracker(80);
        // An earlier short body swipe at x=250 leaves its start behind in the old code.
        tracker.start(250);
        tracker.move(290);
        expect(tracker.end()).toBe('short');
        // A handle drag at x≈21: its start never reached the row, its moves and end do.
        expect(tracker.move(21)).toBeNull();
        expect(tracker.end()).toBe('ignored');
    });

    it('cancel snaps the gesture back without committing', () => {
        const tracker = createSwipeTracker(80);
        tracker.start(0);
        tracker.move(200);
        tracker.cancel();
        expect(tracker.end()).toBe('ignored');
    });
});
