import Chip from '@mui/material/Chip';
import { STATUS_LABELS } from '../../lib/itemSearch';
import type { StoredItem } from '../../types/MyDB';

const STATUS_COLOR: Record<StoredItem['status'], 'default' | 'primary' | 'secondary' | 'success' | 'error' | 'warning' | 'info'> = {
    inbox: 'info',
    nextAction: 'primary',
    calendar: 'secondary',
    waitingFor: 'warning',
    somedayMaybe: 'default',
    done: 'success',
    trash: 'error',
};

export function StatusChip({ status }: { status: StoredItem['status'] }) {
    return <Chip label={STATUS_LABELS[status]} size="small" color={STATUS_COLOR[status]} variant="outlined" />;
}
