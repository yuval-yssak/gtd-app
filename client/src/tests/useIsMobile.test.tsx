// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BELOW_MD_QUERY, useIsMobile, useMediaQuery } from '../hooks/useIsMobile';

/** A matchMedia stub whose queries flip when the simulated viewport width changes. */
function installViewport(initialWidth: number) {
    const state = { width: initialWidth };
    const listeners = new Set<() => void>();
    window.matchMedia = (media: string) => {
        const maxWidth = /max-width:\s*([\d.]+)px/.exec(media)?.[1];
        const minWidth = /min-width:\s*([\d.]+)px/.exec(media)?.[1];
        return {
            get matches() {
                if (maxWidth !== undefined) return state.width <= Number(maxWidth);
                if (minWidth !== undefined) return state.width >= Number(minWidth);
                return false;
            },
            media,
            addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
            removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
        } as unknown as MediaQueryList;
    };
    return {
        resize(width: number) {
            state.width = width;
            for (const listener of listeners) listener();
        },
        listenerCount: () => listeners.size,
    };
}

afterEach(() => {
    cleanup();
    // jsdom ships no matchMedia; removing the stub restores that.
    Reflect.deleteProperty(window, 'matchMedia');
});

describe('useIsMobile', () => {
    it('is true below the md breakpoint (900px) and false at it', () => {
        installViewport(899);
        expect(renderHook(() => useIsMobile()).result.current).toBe(true);

        installViewport(900);
        expect(renderHook(() => useIsMobile()).result.current).toBe(false);
    });

    it('re-renders when the viewport crosses the breakpoint', () => {
        const viewport = installViewport(1200);
        const { result } = renderHook(() => useIsMobile());
        expect(result.current).toBe(false);

        act(() => viewport.resize(400));
        expect(result.current).toBe(true);
    });

    it('unsubscribes on unmount', () => {
        const viewport = installViewport(1200);
        const { unmount } = renderHook(() => useMediaQuery(BELOW_MD_QUERY));
        unmount();
        expect(viewport.listenerCount()).toBe(0);
    });
});
