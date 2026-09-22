import Box from '@mui/material/Box';
import styles from './stageLayout.module.css';

/**
 * A stage's scrollport. It spans the full column width — wider than the 44rem card centered inside
 * it — so a wheel with the pointer in the gutters beside the card scrolls the review content too;
 * scrolling the card itself left those margins dead.
 *
 * It MUST stay a SIBLING of `StageActionBar`, never its ancestor, or the pinned decision buttons
 * scroll away with the content instead of holding one screen position.
 *
 * Cards inside it need `flex-shrink: 0`, or they shrink to fit and scroll internally — which makes
 * this wrapper (and the gutters) inert again.
 */
export function StageCardScroller({ children }: { children: React.ReactNode }) {
    return (
        <Box className={styles.cardScroller} data-testid="stageCardScroller">
            {children}
        </Box>
    );
}
