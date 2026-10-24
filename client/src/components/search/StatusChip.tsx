import { Chip, type ChipTone } from '../../designSystem';
import { STATUS_LABELS } from '../../lib/itemSearch';
import type { StoredItem } from '../../types/MyDB';

// Six tones for seven statuses: inbox and someday/maybe share neutral — the label tells them apart.
const STATUS_TONE: Record<StoredItem['status'], ChipTone> = {
    inbox: 'neutral',
    nextAction: 'accent',
    calendar: 'info',
    waitingFor: 'warning',
    somedayMaybe: 'neutral',
    done: 'success',
    trash: 'error',
};

export function StatusChip({ status }: { status: StoredItem['status'] }) {
    return <Chip label={STATUS_LABELS[status]} tone={STATUS_TONE[status]} variant="outline" />;
}
