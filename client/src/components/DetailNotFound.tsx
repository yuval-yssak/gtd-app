import { Button, Text } from '../designSystem';
import styles from './DetailNotFound.module.css';

interface DetailNotFoundProps {
    message: string;
    /**
     * Names the way back, e.g. "Back to People". Never "Go back": that is the header arrow's
     * accessible name, and a duplicate name breaks strict queries and reads redundantly.
     */
    actionLabel: string;
    onAction: () => void;
}

/** A detail page whose entity no longer exists: why, and the way back to its list. */
export function DetailNotFound({ message, actionLabel, onAction }: DetailNotFoundProps) {
    return (
        <div className={styles.notFound}>
            <Text tone="secondary">{message}</Text>
            <Button onClick={onAction}>{actionLabel}</Button>
        </div>
    );
}
