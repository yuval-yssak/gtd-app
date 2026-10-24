import { Separator, Skeleton } from '../../designSystem';
import styles from './CalendarIntegrationsSkeleton.module.css';

/**
 * Suspense fallback for the Calendar Sync section. It reserves the section's final footprint —
 * one integration row plus the connect button — so when the real content resolves it swaps in
 * without shifting anything below it. Shapes (heights, button widths) mirror the live layout in
 * CalendarIntegrations so the transition reads as content sharpening, not jumping.
 */
export function CalendarIntegrationsSkeleton() {
    return (
        <div data-testid="calendarIntegrationsSkeleton">
            <Separator className={styles.separator} />
            {/* "Google Calendar" heading + "Connected …" caption */}
            <Skeleton className={styles.heading} />
            <Skeleton className={styles.caption} />
            {/* One synced-calendar row */}
            <Skeleton shape="rect" className={styles.calendarRow} />
            {/* Action buttons: Add calendar / Sync now / Disconnect */}
            <div className={styles.actions}>
                <Skeleton shape="rect" className={styles.addButton} />
                <Skeleton shape="rect" className={styles.syncButton} />
                <Skeleton shape="rect" className={styles.disconnectButton} />
            </div>
            {/* Connect-account button below the list */}
            <Skeleton shape="rect" className={styles.connectButton} />
        </div>
    );
}
