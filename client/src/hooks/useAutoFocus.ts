import { useEffect, useRef } from 'react';

/**
 * Imperatively focuses an input on mount. MUI's `autoFocus` prop relies on the native HTML
 * `autofocus` attribute, which the browser only honors for elements present at initial document
 * parse — it never fires for a TextField a route mounts into an already-interactive page.
 */
export function useAutoFocus() {
    const ref = useRef<HTMLInputElement>(null);
    useEffect(() => {
        ref.current?.focus();
    }, []);
    return ref;
}
