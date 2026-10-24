import { Chip, Spinner } from '../designSystem';

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
    return <Chip variant="outline" data-testid="syncingChip" icon={<Spinner size={12} tone="inherit" label="" aria-hidden="true" />} label={label} />;
}
