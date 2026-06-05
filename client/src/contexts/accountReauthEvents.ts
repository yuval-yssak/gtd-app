/**
 * Window-level event the AccountReauthBanner listens for. The sync orchestrator dispatches it when
 * a logged-in account has no Better Auth multi-session entry (so its data can never sync on this
 * device). Kept in its own module — like `syncIssuesEvents.ts` — so the dispatcher side (sync layer)
 * can import it without pulling in the banner's MUI dependencies.
 */
export const ACCOUNT_NEEDS_REAUTH_EVENT = 'gtd:account-needs-reauth';

export interface AccountReauthDetail {
    userId: string;
}

/** Fires the reauth-needed event. No-op outside a browser (Node test env / service worker). */
export function dispatchAccountNeedsReauth(userId: string): void {
    if (typeof window === 'undefined') {
        return; // no-op in Node test env / SW — no window to dispatch on
    }
    window.dispatchEvent(new CustomEvent<AccountReauthDetail>(ACCOUNT_NEEDS_REAUTH_EVENT, { detail: { userId } }));
}

/**
 * Module-level store for which accounts currently need reauth and which the user has dismissed this
 * session. Kept here (not in component state) because AppNav double-mounts the banner — once per
 * drawer variant (permanent + keepMounted temporary). Per-component state would diverge across those
 * instances, so dismissing in one drawer wouldn't stick in the other on a breakpoint change. A single
 * shared store keeps dismiss durable and de-dupe consistent regardless of how many banners mount.
 */
// Note: a flag never clears in-place. `reauthForUserId` always does a full-page OAuth redirect, so a
// successful re-login reloads the page and wipes this module store. If re-auth ever becomes in-place
// (no reload), an explicit un-flag path must be added here or a stale banner will linger.
const flaggedUserIds = new Set<string>();
const dismissedUserIds = new Set<string>();
const listeners = new Set<() => void>();

// Cached snapshot — useSyncExternalStore requires getSnapshot to return a referentially stable value
// between notifications, so we rebuild it only when the visible set actually changes.
let visibleSnapshot: string[] = [];

function recomputeVisible(): void {
    const next = [...flaggedUserIds].filter((id) => !dismissedUserIds.has(id));
    // Preserve reference identity when membership is unchanged (avoids a needless re-render loop).
    if (next.length === visibleSnapshot.length && next.every((id, i) => id === visibleSnapshot[i])) {
        return;
    }
    visibleSnapshot = next;
    for (const notify of listeners) {
        notify();
    }
}

/** Records that `userId` needs reauth. Idempotent — repeated flags don't re-notify if nothing changed. */
export function flagAccountNeedsReauth(userId: string): void {
    if (flaggedUserIds.has(userId)) {
        return;
    }
    flaggedUserIds.add(userId);
    recomputeVisible();
}

/** Dismisses the banner for `userId` for the rest of this session, surviving the orchestrator's re-dispatches. */
export function dismissAccountReauth(userId: string): void {
    if (dismissedUserIds.has(userId)) {
        return;
    }
    dismissedUserIds.add(userId);
    recomputeVisible();
}

/** useSyncExternalStore subscribe — registers a re-render callback, returns the unsubscribe. */
export function subscribeAccountReauth(onChange: () => void): () => void {
    listeners.add(onChange);
    return () => {
        listeners.delete(onChange);
    };
}

/** useSyncExternalStore getSnapshot — the userIds with an active, non-dismissed reauth flag. */
export function getReauthFlaggedUserIds(): string[] {
    return visibleSnapshot;
}

/**
 * Bridges the window event into the shared store. Installed once (guarded), regardless of how many
 * banner instances mount — so we attach a single `gtd:account-needs-reauth` listener rather than one
 * per drawer variant. No-op outside a browser (Node test env / SW).
 */
let bridgeInstalled = false;
export function ensureAccountReauthBridge(): void {
    if (bridgeInstalled || typeof window === 'undefined') {
        return;
    }
    bridgeInstalled = true;
    window.addEventListener(ACCOUNT_NEEDS_REAUTH_EVENT, (event) => {
        flagAccountNeedsReauth((event as CustomEvent<AccountReauthDetail>).detail.userId);
    });
}

/** Test-only: clears the shared store between cases. */
export function resetAccountReauthStore(): void {
    flaggedUserIds.clear();
    dismissedUserIds.clear();
    visibleSnapshot = [];
}
