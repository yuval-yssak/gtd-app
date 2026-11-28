import { useRef } from 'react';
import styles from './stageLayout.module.css';
import { useForwardStrayWheel } from './useForwardStrayWheel';

/**
 * A stage's scrollport. It spans the page's full width — far wider than the 44rem card centered
 * inside it — so a wheel with the pointer in the gutters beside the card scrolls the review content
 * too; scrolling the card itself left those margins dead.
 *
 * It MUST stay a SIBLING of `StageActionBar`, never its ancestor, or the pinned decision buttons
 * scroll away with the content instead of holding one screen position.
 *
 * It reaches the page's right edge, so its scrollbar is the page's, and wheels that land outside
 * it where nothing else would scroll are forwarded to it (`useForwardStrayWheel`).
 *
 * Cards inside it need `flex-shrink: 0`, or they shrink to fit and scroll internally — which makes
 * this wrapper (and the gutters) inert again.
 */
export function StageCardScroller({ children }: { children: React.ReactNode }) {
    const scrollerRef = useRef<HTMLDivElement>(null);
    useForwardStrayWheel(scrollerRef);
    return (
        <div ref={scrollerRef} className={styles.cardScroller} data-testid="stageCardScroller">
            {children}
        </div>
    );
}
