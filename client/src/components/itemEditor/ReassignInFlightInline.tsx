import { Button, Callout } from '../../designSystem';
import styles from './ReassignInFlightInline.module.css';

interface Props {
    onClose: () => void;
    /** Defaults to 'item' so existing call sites in the item editor stay valid without changes. */
    entityLabel?: 'item' | 'routine' | undefined;
}

/**
 * Shown in place of the editor body while a cross-account reassign is in flight: opening the
 * editor on an entity with an in-flight cross-account reassign would seed ownerUserId from the
 * overlayed (target) user and a save would write IDB under the target — the misroute the
 * reassign flow exists to prevent. Refuse the edit until the move resolves.
 */
export function ReassignInFlightInline({ onClose, entityLabel = 'item' }: Props) {
    return (
        <div>
            <Callout tone="info" variant="outline">
                This {entityLabel} is being moved to another account. You can edit it once the move completes.
            </Callout>
            <div className={styles.actions}>
                <Button onClick={onClose}>Close</Button>
            </div>
        </div>
    );
}
