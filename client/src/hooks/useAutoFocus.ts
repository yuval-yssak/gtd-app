import { useEffect, useRef } from 'react';

/**
 * Focuses the referenced input once, after it mounts — for a field that should take focus when
 * its page or panel appears.
 */
export function useAutoFocus() {
    const ref = useRef<HTMLInputElement>(null);
    useEffect(() => {
        ref.current?.focus();
    }, []);
    return ref;
}
