import { useRef, useState } from 'react';
import { createSwipeTracker, TAP_THRESHOLD_PX } from '../lib/swipeTracker';

interface UseSwipeGestureOptions {
    onSwipeRight: () => void;
    onSwipeLeft: () => void;
    /** Minimum px to travel before the swipe commits. Default: 80 */
    threshold?: number;
}

type SwipeDirection = 'right' | 'left' | null;

interface UseSwipeGestureResult {
    touchHandlers: {
        onTouchStart: (e: React.TouchEvent) => void;
        onTouchMove: (e: React.TouchEvent) => void;
        onTouchEnd: () => void;
        onTouchCancel: () => void;
    };
    /** Current horizontal offset applied to the row while the finger is down */
    translateX: number;
    /** Set after the finger lifts; null means the gesture was a tap (< 10px travel) */
    committedDirection: SwipeDirection;
    /**
     * True if the last gesture moved >= 10px (i.e., it was a drag, not a tap).
     * Read this ref inside onClick to decide whether to suppress the tap action.
     * Using a ref (not state) avoids the stale-closure problem when onClick fires
     * synchronously after touchEnd in the same event flush.
     */
    wasDragRef: React.MutableRefObject<boolean>;
}

export function useSwipeGesture({ onSwipeRight, onSwipeLeft, threshold = 80 }: UseSwipeGestureOptions): UseSwipeGestureResult {
    // Created once (lazy init): the tracker holds the live gesture, so onTouchEnd never reads a stale render's value.
    const [tracker] = useState(() => createSwipeTracker(threshold));
    const wasDragRef = useRef<boolean>(false);
    const [translateX, setTranslateX] = useState(0);
    const [committedDirection, setCommittedDirection] = useState<SwipeDirection>(null);

    function onTouchStart(e: React.TouchEvent) {
        // touches[0] is always present during touchstart (at least one finger is down)
        if (!e.touches[0]) {
            return;
        }
        tracker.start(e.touches[0].clientX);
        wasDragRef.current = false;
        setCommittedDirection(null);
    }

    function onTouchMove(e: React.TouchEvent) {
        const offset = e.touches[0] ? tracker.move(e.touches[0].clientX) : null;
        if (offset === null) {
            return;
        }
        // Mark as a drag once the finger moves far enough to distinguish from a tap
        if (Math.abs(offset) >= TAP_THRESHOLD_PX) {
            wasDragRef.current = true;
        }
        setTranslateX(offset);
    }

    function onTouchEnd() {
        const outcome = tracker.end();
        // Snap back immediately regardless of outcome
        setTranslateX(0);
        setCommittedDirection(outcome === 'right' || outcome === 'left' ? outcome : null);
        if (outcome === 'right') {
            onSwipeRight();
        } else if (outcome === 'left') {
            onSwipeLeft();
        }
    }

    function onTouchCancel() {
        tracker.cancel();
        setTranslateX(0);
        setCommittedDirection(null);
    }

    return {
        touchHandlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel },
        translateX,
        committedDirection,
        wasDragRef,
    };
}
