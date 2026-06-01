import Box from '@mui/material/Box';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import Skeleton from '@mui/material/Skeleton';
import { skeletonRowWidth } from '../lib/syncIndicators';

interface ListSkeletonProps {
    /** How many placeholder rows to render. Defaults to 5 — enough to fill the first viewport. */
    rows?: number;
}

/**
 * Shimmer placeholder rows shown while the first-time bootstrap sync is in flight (see
 * `isInitialSyncing` in AppDataProvider). Replaces the misleading empty-state that used to render
 * during the ~20s window when IDB is still empty. The varied widths mimic real item titles so the
 * skeleton reads as "list loading" rather than a static block.
 */
export function ListSkeleton({ rows = 5 }: ListSkeletonProps) {
    return (
        <List disablePadding data-testid="listSkeleton" aria-busy="true" aria-label="Loading items">
            {Array.from({ length: rows }, (_, i) => `skeleton-row-${i}`).map((rowKey, i) => (
                // Stable string key derived from the fixed index — this list never reorders or filters.
                <ListItem key={rowKey} disablePadding sx={{ py: 1.25 }}>
                    <Box sx={{ width: '100%' }}>
                        {/* Deterministic varied widths so the shimmer reads as real rows, not a static block. */}
                        <Skeleton variant="text" width={skeletonRowWidth(i)} height={24} />
                        <Skeleton variant="text" width="35%" height={16} />
                    </Box>
                </ListItem>
            ))}
        </List>
    );
}
