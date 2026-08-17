import { type AnyRouter, useNavigate, useRouter } from '@tanstack/react-router';

// Detail routes never qualify as a back target: recording them would make ESC on one detail
// page push another (routine page → its next-item link → item page → ESC ping-pongs between
// the two forever). ESC always aims at the last *list* the user was on.
const DETAIL_PAGE_PREFIXES = ['/item/', '/routine/', '/person/'];
const isDetailPagePathname = (pathname: string) => DETAIL_PAGE_PREFIXES.some((prefix) => pathname.startsWith(prefix));

// Href + pathname of the last list location the user was on — the push target for detail-page
// "back". Module-level (not per-hook) because the navigation that records it happens BEFORE the
// detail page mounts, so a hook-scoped subscription would always miss it.
let backTarget: { href: string; pathname: string } | null = null;
let isTrackingBackTarget = false;

/**
 * Starts recording the previous in-app list location. Called once at router creation (App.tsx);
 * idempotent so hot-reload double-calls are harmless.
 */
export function initNavigateBackTracking(router: AnyRouter): void {
    if (isTrackingBackTarget) {
        return;
    }
    isTrackingBackTarget = true;
    router.subscribe('onBeforeLoad', (event) => {
        // Same-href replaces (search-field debounce writes) are not a "place the user came
        // from", and detail pages are excluded per the comment above — keep the older target.
        if (event.fromLocation && event.fromLocation.href !== event.toLocation.href && !isDetailPagePathname(event.fromLocation.pathname)) {
            backTarget = { href: event.fromLocation.href, pathname: event.fromLocation.pathname };
        }
    });
}

/**
 * Back-navigation for detail pages. Pushes the exact previous list location (search params
 * included — also the key the source list's scroll restoration saved under) instead of popping
 * history, so the detail page stays in the history stack and the browser Back button returns to
 * it after leaving via ESC / the back arrow. The cost is that each open→leave cycle grows the
 * history stack by two entries instead of netting zero — accepted for the Back-button behavior.
 * Falls back to `fallbackTo` on deep links with no recorded list location.
 */
export function useNavigateBack() {
    const navigate = useNavigate();
    const router = useRouter();
    return (fallbackTo: string) => {
        const target = backTarget;
        if (target && target.pathname !== router.latestLocation.pathname) {
            // history.push (not navigate): the href carries its own search string, and pushes
            // still run through the router's navigation blockers (unsaved-changes guard).
            router.history.push(target.href);
        } else {
            void navigate({ to: fallbackTo });
        }
    };
}
