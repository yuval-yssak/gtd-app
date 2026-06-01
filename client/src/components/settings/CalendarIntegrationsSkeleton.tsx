import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import Skeleton from '@mui/material/Skeleton';

/**
 * Suspense fallback for the Calendar Sync section. It reserves the section's final footprint —
 * one integration row plus the connect button — so when the real content resolves it swaps in
 * without shifting anything below it. Shapes (heights, button widths) mirror the live layout in
 * CalendarIntegrations so the transition reads as content sharpening, not jumping.
 */
export function CalendarIntegrationsSkeleton() {
    return (
        <Box data-testid="calendarIntegrationsSkeleton">
            <Divider sx={{ mb: 1.5 }} />
            {/* "Google Calendar" heading + "Connected …" caption */}
            <Skeleton variant="text" width={140} height={20} />
            <Skeleton variant="text" width={180} height={16} />
            {/* One synced-calendar row */}
            <Skeleton variant="rounded" height={32} sx={{ mt: 1 }} />
            {/* Action buttons: Add calendar / Sync now / Disconnect */}
            <Box sx={{ display: 'flex', gap: 1, mt: 1.5 }}>
                <Skeleton variant="rounded" width={110} height={31} />
                <Skeleton variant="rounded" width={88} height={31} />
                <Skeleton variant="rounded" width={96} height={31} />
            </Box>
            {/* Connect-account button below the list */}
            <Skeleton variant="rounded" width={260} height={31} sx={{ mt: 2 }} />
        </Box>
    );
}
