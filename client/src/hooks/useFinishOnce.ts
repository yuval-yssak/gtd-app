import { useEffect, useEffectEvent, useRef } from 'react';

/**
 * Runs `onFinished` once, the first time `isDone` is true — never again for this mount, however
 * often the host re-renders (a host whose callback changes identity every render would otherwise
 * repeat a toast and a navigation while that navigation is still committing).
 */
export function useFinishOnce(isDone: boolean, onFinished: () => void): void {
    const hasFinishedRef = useRef(false);
    const finish = useEffectEvent(onFinished);
    useEffect(() => {
        if (!isDone || hasFinishedRef.current) {
            return;
        }
        hasFinishedRef.current = true;
        finish();
    }, [isDone]);
}
