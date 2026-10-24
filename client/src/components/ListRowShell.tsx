import { type ReactNode, useEffect, useEffectEvent, useState } from 'react';
import styles from './ListRowShell.module.css';

/** How long a ghost row lingers fully visible before collapsing away. */
const GHOST_LINGER_MS = 700;
/** The collapse animation's length — `--duration-normal`, which `.collapse` transitions with. */
const GHOST_COLLAPSE_MS = 200;

/** Marks a row that already left its list (a fading ghost) — row shortcuts must not act on its stale snapshot. */
export const GHOST_ROW_ATTR = 'data-ghost-row';

interface ListRowShellProps {
    itemId: string;
    /** `li` inside a real `<ul>`; the default `div` suits virtualised lists, whose measuring wrapper a <ul> cannot hold. */
    as?: 'div' | 'li' | undefined;
    isGhost?: boolean | undefined;
    /** Fired after the ghost's collapse animation finishes — consume the ghost here. */
    onGhostExited?: ((itemId: string) => void) | undefined;
    children: ReactNode;
}

/**
 * Shared wrapper for restorable list rows. Always renders the `data-list-item-id`
 * anchor that useListScrollRestoration re-anchors on, and — when the row is a ghost
 * (an item just removed from this list) — shows it faded and inert for a beat, then
 * collapses it away.
 *
 * The collapsing wrapper surrounds every row (not just ghosts) so an in-list removal transitions
 * the existing row to its ghost state without remounting the subtree.
 */
export function ListRowShell({ itemId, as: Element = 'div', isGhost = false, onGhostExited, children }: ListRowShellProps) {
    const isCollapsing = useGhostCollapse(isGhost, () => onGhostExited?.(itemId));
    return (
        <Element className={styles.collapse} data-collapsing={isCollapsing || undefined}>
            <div data-list-item-id={itemId} className={styles.row} {...(isGhost ? { 'data-testid': 'ghostListRow', [GHOST_ROW_ATTR]: '' } : {})}>
                {children}
            </div>
        </Element>
    );
}

/**
 * A ghost lingers, then collapses, then reports it is gone. Timers rather than `transitionend`:
 * with reduced motion there is no transition, and the ghost must still be consumed.
 */
function useGhostCollapse(isGhost: boolean, onExited: () => void) {
    const [isCollapsing, setIsCollapsing] = useState(false);
    const onCollapsed = useEffectEvent(onExited);
    useEffect(() => {
        if (!isGhost) {
            return;
        }
        const lingerTimer = setTimeout(() => setIsCollapsing(true), GHOST_LINGER_MS);
        const exitTimer = setTimeout(onCollapsed, GHOST_LINGER_MS + GHOST_COLLAPSE_MS);
        return () => {
            clearTimeout(lingerTimer);
            clearTimeout(exitTimer);
            // A row ghosted again later must linger again, not start out collapsed.
            setIsCollapsing(false);
        };
    }, [isGhost]);
    // A row that is no longer a ghost (it came back) is never collapsed, whatever the timer reached.
    return isGhost && isCollapsing;
}
