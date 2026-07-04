import { useEffect, useRef, useState } from 'react';
import { type AutosaveController, type AutosaveControllerOptions, createAutosaveController } from '../lib/autosaveController';

/**
 * React wrapper around createAutosaveController. The controller instance is stable for the
 * component's lifetime; the commit callback always sees the latest render's closure (ref-routed),
 * and unmount flushes any pending change so navigating away never drops the tail of a burst.
 */
export function useAutosave<T>(options: AutosaveControllerOptions<T>): AutosaveController<T> {
    const commitRef = useRef(options.commit);
    commitRef.current = options.commit;

    const [controller] = useState(() =>
        createAutosaveController<T>({
            ...options,
            commit: (value, baseline) => commitRef.current(value, baseline),
        }),
    );

    // Flush-on-unmount so navigating away never drops the tail of a burst. StrictMode-safe: the
    // controller instance lives in useState (survives the double-mount) and flush() on a clean
    // controller is a no-op, so the spurious first cleanup does nothing.
    useEffect(() => {
        return () => {
            void controller.flush();
        };
    }, [controller]);

    return controller;
}
