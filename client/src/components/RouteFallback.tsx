import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';

interface Props {
    /** Test id forwarded to the spinner; lets specs distinguish boot vs route vs inline fallbacks. */
    testId?: string;
}

/**
 * Centered MUI spinner used as the fallback for Suspense boundaries that wrap a full route.
 * Standardized so future skeleton variants can land here without touching pages.
 */
export function RouteFallback({ testId = 'routeFallback' }: Props = {}) {
    return (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 6 }}>
            <CircularProgress data-testid={testId} />
        </Box>
    );
}
