import { useCallback, useEffect, useRef } from 'react';

/**
 * `isMounted()` — for async work that may settle after the host unmounted (a request outliving a
 * closed sheet or an advanced wizard card), so the resolution can skip its setState calls. The
 * ref is re-armed on every mount so StrictMode's double-mount does not leave it stuck at false.
 */
export function useIsMounted(): () => boolean {
    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);
    return useCallback(() => isMountedRef.current, []);
}
