import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';

/**
 * Inline loading placeholder for list pages while AppDataProvider's first IDB read is in flight.
 * Without this guard, a hard refresh briefly renders the empty-state copy ("Inbox zero", "No
 * upcoming calendar items.", etc.) before the cached items appear. See `AppData.isInitialLoading`.
 */
export function PageLoadingSpinner() {
    return (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 6 }}>
            <CircularProgress data-testid="pageLoadingSpinner" />
        </Box>
    );
}
