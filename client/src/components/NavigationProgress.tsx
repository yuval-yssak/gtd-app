import LinearProgress from '@mui/material/LinearProgress';
import { useRouterState } from '@tanstack/react-router';
import styles from './NavigationProgress.module.css';

/**
 * Thin indeterminate bar pinned to the top of the viewport while a navigation is in flight —
 * either the load phase (`status === 'pending'`) or the React transition that renders the
 * destination route (`isTransitioning`). Router-level transitions keep the old page on screen
 * until the new one commits, so without this the user gets zero feedback on slower devices.
 * The CSS delays visibility ~150ms so fast navigations (and the search page's debounced
 * same-route param writes) never flash it.
 */
export function NavigationProgress() {
    const isNavigating = useRouterState({ select: (s) => s.isTransitioning || s.status === 'pending' });
    if (!isNavigating) {
        return null;
    }
    return <LinearProgress className={styles.navigationProgress} data-testid="navigationProgress" />;
}
