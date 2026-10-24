import { Spinner } from '../designSystem';
import styles from './RouteFallback.module.css';

interface Props {
    /** Test id forwarded to the spinner; lets specs distinguish boot vs route vs inline fallbacks. */
    testId?: string | undefined;
}

/**
 * Centered spinner used as the fallback for Suspense boundaries that wrap a full route.
 * Standardized so future skeleton variants can land here without touching pages.
 */
export function RouteFallback({ testId = 'routeFallback' }: Props = {}) {
    return (
        <div className={styles.root}>
            <Spinner size={40} data-testid={testId} />
        </div>
    );
}
