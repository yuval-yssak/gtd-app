import { CloudOff, CloudUpload } from 'lucide-react';
import { Chip, Tooltip } from '../designSystem';
import type { ItemFreshness } from '../lib/syncFreshness';
import styles from './FreshnessBadge.module.css';

// The label carries the meaning on its own: tooltips never open on touch, and a phone in an
// elevator is exactly where this badge matters. The hint becomes the badge's accessible name (see
// Tooltip), so it avoids field-label words (date, time, title…) a label lookup would also match.
const BADGES = {
    unverified: {
        label: 'Not verified',
        hint: "Showing the copy saved on this device. It hasn't been checked with the server yet, so newer changes may be missing.",
        icon: <CloudOff />,
    },
    unsynced: {
        label: 'Not synced',
        hint: 'Your changes are saved on this device and will reach the server once the connection works.',
        icon: <CloudUpload />,
    },
} as const;

/** Says when the entity on screen is not known to match the server. Renders nothing when it is. */
export function FreshnessBadge({ freshness }: { freshness: ItemFreshness }) {
    if (freshness === 'current') {
        return null;
    }
    const badge = BADGES[freshness];
    return (
        <Tooltip title={badge.hint}>
            <Chip
                variant="outline"
                tone={freshness === 'unsynced' ? 'warning' : 'neutral'}
                icon={badge.icon}
                label={badge.label}
                data-testid="freshnessBadge"
                data-freshness={freshness}
                className={styles.badge}
            />
        </Tooltip>
    );
}
