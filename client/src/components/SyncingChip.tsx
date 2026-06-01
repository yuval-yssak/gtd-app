import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';

interface SyncingChipProps {
    /** Label shown next to the spinner, e.g. "Syncing calendar…". */
    label: string;
}

/**
 * Small inline "syncing" affordance for placement next to a page title. Used on the calendar +
 * routines pages while a Google Calendar sync runs (`isCalendarSyncing`). Deliberately lightweight
 * — the data is already on screen, this only signals a background refresh is underway.
 */
export function SyncingChip({ label }: SyncingChipProps) {
    return (
        <Chip
            size="small"
            variant="outlined"
            data-testid="syncingChip"
            icon={<CircularProgress size={12} thickness={5} sx={{ ml: 0.75 }} />}
            label={label}
            sx={{ color: 'text.secondary', borderColor: 'divider' }}
        />
    );
}
