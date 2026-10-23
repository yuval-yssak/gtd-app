import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts';
import { GoToHint } from './GoToHint';

/**
 * The app-wide keyboard layer (`g` jumps, `?`, `/`, F6) as a leaf component: the pending-`g` state
 * re-renders only this hint, never the layout shell and the page under it.
 */
export function GlobalShortcuts() {
    const { isLeaderPending } = useGlobalShortcuts();
    return <GoToHint isOpen={isLeaderPending} />;
}
