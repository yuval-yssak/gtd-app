import { useEscapeStepsOutOfFields } from '../hooks/useEscapeStepsOutOfFields';
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts';
import { GoToHint } from './GoToHint';

/**
 * The app-wide keyboard layer (`g` jumps, `?`, `/`, F6, Escape out of a text field) as a leaf component: the pending-`g` state
 * re-renders only this hint, never the layout shell and the page under it.
 */
export function GlobalShortcuts() {
    const { isLeaderPending } = useGlobalShortcuts();
    useEscapeStepsOutOfFields();
    return <GoToHint isOpen={isLeaderPending} />;
}
