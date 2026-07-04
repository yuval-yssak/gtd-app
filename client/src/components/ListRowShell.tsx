import Box from '@mui/material/Box';
import Collapse from '@mui/material/Collapse';
import classNames from 'classnames';
import { type ReactNode, useEffect, useState } from 'react';
import styles from './ListRowShell.module.css';

/** How long a ghost row lingers fully visible before collapsing away. */
const GHOST_LINGER_MS = 700;

interface ListRowShellProps {
    itemId: string;
    isGhost?: boolean;
    /** Fired after the ghost's collapse animation finishes — consume the ghost here. */
    onGhostExited?: (itemId: string) => void;
    children: ReactNode;
}

/**
 * Shared wrapper for restorable list rows. Always renders the `data-list-item-id`
 * anchor that useListScrollRestoration re-anchors on, and — when the row is a ghost
 * (an item just removed from this list) — shows it faded and inert for a beat, then
 * collapses it away.
 *
 * The Collapse wraps every row (not just ghosts) so an in-list removal transitions
 * the existing row to its ghost state without remounting the subtree.
 */
export function ListRowShell({ itemId, isGhost = false, onGhostExited, children }: ListRowShellProps) {
    const [isCollapsing, setIsCollapsing] = useState(false);
    useEffect(() => {
        if (!isGhost) {
            return;
        }
        const lingerTimer = setTimeout(() => setIsCollapsing(true), GHOST_LINGER_MS);
        return () => clearTimeout(lingerTimer);
    }, [isGhost]);
    return (
        <Collapse in={!isCollapsing} appear={false} onExited={() => onGhostExited?.(itemId)}>
            <Box data-list-item-id={itemId} className={classNames({ [styles.ghostRow]: isGhost })} {...(isGhost ? { 'data-testid': 'ghostListRow' } : {})}>
                {children}
            </Box>
        </Collapse>
    );
}
