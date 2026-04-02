import { useRef, useState } from 'react';

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

/** Minimum px travel that distinguishes a drag from a tap */
const TAP_THRESHOLD_PX = 10;

export function useSwipeGesture({ onSwipeRight, onSwipeLeft, threshold = 80 }: UseSwipeGestureOptions): UseSwipeGestureResult {
    const startXRef = useRef<number>(0);
    // Ref (not state) for the live delta so onTouchEnd always reads the current value,
    // not a value captured by a stale closure from a previous render.
    const currentDeltaRef = useRef<number>(0);
    const wasDragRef = useRef<boolean>(false);
    const [translateX, setTranslateX] = useState(0);
    const [committedDirection, setCommittedDirection] = useState<SwipeDirection>(null);

    function onTouchStart(e: React.TouchEvent) {
        // touches[0] is always present during touchstart (at least one finger is down)
        if (!e.touches[0]) {
            return;
        }
        startXRef.current = e.touches[0].clientX;
        currentDeltaRef.current = 0;
        wasDragRef.current = false;
        setCommittedDirection(null);
    }

    function onTouchMove(e: React.TouchEvent) {
        if (!e.touches[0]) {
            return;
        }
        const delta = e.touches[0].clientX - startXRef.current;
        // Clamp so the row doesn't slide too far off-screen
        const clamped = Math.max(-120, Math.min(120, delta));
        currentDeltaRef.current = clamped;
        // Mark as a drag once the finger moves far enough to distinguish from a tap
        if (Math.abs(clamped) >= TAP_THRESHOLD_PX) {
            wasDragRef.current = true;
        }
        setTranslateX(clamped);
    }

    function onTouchEnd() {
        // Read from the ref, not from the translateX state value, which may be one
        // render behind due to React batching the setTranslateX call from onTouchMove.
        const delta = currentDeltaRef.current;
        currentDeltaRef.current = 0;
        // Snap back immediately regardless of outcome
        setTranslateX(0);

        if (Math.abs(delta) < TAP_THRESHOLD_PX) {
            // Treat as a tap; let the component's onClick handler run normally
            setCommittedDirection(null);
            return;
        }

        if (delta > threshold) {
            setCommittedDirection('right');
            onSwipeRight();
        } else if (delta < -threshold) {
            setCommittedDirection('left');
            onSwipeLeft();
        } else {
            // Didn't reach threshold — snap back without committing
            setCommittedDirection(null);
        }
    }

    return {
        touchHandlers: { onTouchStart, onTouchMove, onTouchEnd },
        translateX,
        committedDirection,
        wasDragRef,
    };
}
