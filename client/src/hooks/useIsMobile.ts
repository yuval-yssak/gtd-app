import { useCallback, useSyncExternalStore } from 'react';

// The md breakpoint (900px, MUI's `md`). Media queries cannot read custom properties, so this
// literal is mirrored by the @media rules that switch layout at the same width.
export const BELOW_MD_QUERY = '(max-width: 899.98px)';
// The sm breakpoint (600px, MUI's `sm`).
export const AT_LEAST_SM_QUERY = '(min-width: 600px)';

export function useMediaQuery(query: string) {
    const subscribe = useCallback(
        (onChange: () => void) => {
            const list = window.matchMedia(query);
            list.addEventListener('change', onChange);
            return () => list.removeEventListener('change', onChange);
        },
        [query],
    );
    return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

/** Phone and small-tablet layout: the temporary nav drawer, stacked rows. */
export function useIsMobile() {
    return useMediaQuery(BELOW_MD_QUERY);
}
