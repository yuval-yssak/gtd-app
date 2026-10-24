import { useRouterState } from '@tanstack/react-router';
import { ProgressBar } from '../designSystem';
import styles from './NavigationProgress.module.css';

/**
 * Thin indeterminate bar pinned to the top of the viewport while a navigation is in flight. The
 * router holds `status === 'pending'` through both the load phase and the React transition that
 * renders the destination route. Router-level transitions keep the old page on screen
 * until the new one commits, so without this the user gets zero feedback on slower devices.
 * The CSS delays visibility ~150ms so fast navigations (and the search page's debounced
 * same-route param writes) never flash it.
 */
export function NavigationProgress() {
    const isNavigating = useRouterState({ select: (s) => s.status === 'pending' });
    if (!isNavigating) {
        return null;
    }
    return <ProgressBar value={null} aria-label="Loading page" className={styles.navigationProgress} data-testid="navigationProgress" />;
}
