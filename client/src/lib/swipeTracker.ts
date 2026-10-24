/**
 * The swipe row's gesture state, without React (unit-tested). A gesture exists only between a
 * `start` and its `end` / `cancel`: a move or end with no start of its own — touches that began on
 * a child that keeps its gesture to itself, like the reorder handle — is ignored instead of being
 * measured from an older gesture's start (which once trashed a row being dragged by its handle).
 */

/** Minimum px travel that distinguishes a drag from a tap. */
export const TAP_THRESHOLD_PX = 10;
/** How far the row may slide either way. */
const MAX_OFFSET_PX = 120;

export type SwipeOutcome = 'ignored' | 'tap' | 'short' | 'right' | 'left';

interface GestureState {
    startX: number | null;
    delta: number;
}

function clampOffset(delta: number): number {
    return Math.max(-MAX_OFFSET_PX, Math.min(MAX_OFFSET_PX, delta));
}

function outcomeOf(delta: number, threshold: number): SwipeOutcome {
    if (Math.abs(delta) < TAP_THRESHOLD_PX) {
        return 'tap';
    }
    if (delta > threshold) {
        return 'right';
    }
    return delta < -threshold ? 'left' : 'short';
}

export function createSwipeTracker(threshold: number) {
    const state: GestureState = { startX: null, delta: 0 };
    const reset = () => {
        state.startX = null;
        state.delta = 0;
    };
    return {
        start: (x: number) => {
            state.startX = x;
            state.delta = 0;
        },
        /** The row's clamped offset, or null when no gesture of this row is in progress. */
        move: (x: number): number | null => {
            if (state.startX === null) {
                return null;
            }
            state.delta = clampOffset(x - state.startX);
            return state.delta;
        },
        end: (): SwipeOutcome => {
            const outcome = state.startX === null ? 'ignored' : outcomeOf(state.delta, threshold);
            reset();
            return outcome;
        },
        /** The browser took the touch (a scroll, a system gesture): snap back, never commit. */
        cancel: reset,
    };
}
