import { type NavigateOptions, useRouter } from '@tanstack/react-router';
import { useCallback } from 'react';

/** The subset of a mouse event needed to detect the "open in a new tab" gesture. */
export interface ModifierClickSource {
    metaKey: boolean;
    ctrlKey: boolean;
}

/** The subset of the TanStack router the navigation helper needs — method syntax so the real (generic) router stays assignable. */
export interface RouterNavigator {
    buildLocation(options: NavigateOptions): { href: string };
    navigate(options: NavigateOptions): Promise<void> | void;
}

// macOS/iOS use ctrl+click for the context menu, so ctrl must not double as the new-tab
// modifier there — a native anchor doesn't open a new tab on macOS ctrl+click either.
function isApplePlatform() {
    return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/** cmd+click (macOS) / ctrl+click (Windows, Linux) — the browser gesture for "open in a new tab". */
export function isNewTabClick(event: ModifierClickSource, isApple: boolean = isApplePlatform()) {
    return event.metaKey || (event.ctrlKey && !isApple);
}

/**
 * Core of the modifier-aware navigation: a new-tab gesture opens the destination in a new tab,
 * anything else (including `event === undefined` for programmatic navigations) navigates in place.
 * Kept router-injectable so the branching is unit-testable without a React renderer.
 */
export function navigateOrOpenNewTab(router: RouterNavigator, event: ModifierClickSource | undefined, options: NavigateOptions) {
    if (event && isNewTabClick(event)) {
        // No 'noopener' feature string: it forces window.open to return null, which would make a
        // successful open indistinguishable from a popup-blocked one (same-origin tab, so the
        // opener handle is harmless). A null return means a popup blocker swallowed the open —
        // fall back to in-tab navigation rather than dropping the click on the floor.
        if (window.open(router.buildLocation(options).href, '_blank')) {
            return;
        }
    }
    void router.navigate(options);
}

/**
 * Modifier-aware replacement for `useNavigate` on click handlers that cannot be real `<a>` links
 * (rows whose click may open an inline editor instead of navigating, MUI components with
 * conflicting Link typings). Pass `undefined` as the event for programmatic navigations that
 * should always stay in-tab.
 */
export function useNewTabAwareNavigate() {
    const router = useRouter();
    return useCallback((event: ModifierClickSource | undefined, options: NavigateOptions) => navigateOrOpenNewTab(router, event, options), [router]);
}
