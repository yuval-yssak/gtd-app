import { type RefObject, useEffect } from 'react';
import { strayWheelPixels } from '../../lib/strayWheel';

/**
 * Sends a wheel that would scroll nothing — over the review header, the pinned action bar, the
 * page padding or a sidebar that fits — to the stage's scrollport, so the review scrolls wherever
 * the pointer is. A wheel over something that scrolls itself (the notes, a long sidebar) is left alone.
 */
export function useForwardStrayWheel(scrollerRef: RefObject<HTMLElement | null>) {
    useEffect(() => {
        const scroller = scrollerRef.current;
        const appRoot = scroller?.ownerDocument.getElementById('root');
        if (!scroller || !appRoot) {
            return;
        }
        // Passive: a stray wheel has no default action to cancel — nothing under it would scroll.
        const onWheel = (event: WheelEvent) => {
            const pixels = strayWheelPixels(event, { scroller, appRoot });
            if (pixels !== null) scroller.scrollBy({ top: pixels });
        };
        window.addEventListener('wheel', onWheel, { passive: true });
        return () => window.removeEventListener('wheel', onWheel);
    }, [scrollerRef]);
}
