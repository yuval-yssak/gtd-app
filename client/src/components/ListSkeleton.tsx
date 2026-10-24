import { Skeleton } from '../designSystem';
import { skeletonRowWidth } from '../lib/syncIndicators';
import styles from './ListSkeleton.module.css';

interface ListSkeletonProps {
    /** How many placeholder rows to render. Defaults to 5 — enough to fill the first viewport. */
    rows?: number | undefined;
}

/**
 * Shimmer placeholder rows shown while the first-time bootstrap sync is in flight (see
 * `isInitialSyncing` in AppDataProvider). Replaces the misleading empty-state that used to render
 * during the ~20s window when IDB is still empty. The varied widths mimic real item titles so the
 * skeleton reads as "list loading" rather than a static block.
 */
export function ListSkeleton({ rows = 5 }: ListSkeletonProps) {
    return (
        <ul className={styles.list} data-testid="listSkeleton" aria-busy="true" aria-label="Loading items">
            {/* Stable string key derived from the fixed index — this list never reorders or filters. */}
            {Array.from({ length: rows }, (_, i) => `skeleton-row-${i}`).map((rowKey, i) => (
                <li key={rowKey} className={styles.row}>
                    {/* Deterministic varied widths so the shimmer reads as real rows; the width is per-row data. */}
                    <Skeleton className={styles.title} style={{ inlineSize: skeletonRowWidth(i) }} />
                    <Skeleton className={styles.meta} />
                </li>
            ))}
        </ul>
    );
}
