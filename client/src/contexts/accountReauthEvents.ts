import dayjs from 'dayjs';

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
// Note: `reauthForUserId` does a full-page OAuth redirect, so a successful re-login wipes this
// module store in the redirecting tab. Every OTHER open tab keeps its stale flag — those are
// cleared via `clearAccountReauth`, driven by the cross-tab resolved bridge below and by a
// subsequently successful sync pass for the flagged user.
const flaggedUserIds = new Set<string>();
const dismissedUserIds = new Set<string>();
// Separate, weaker tier than `dismissedUserIds`: closing the blocking dialog ("Not now") only
// acknowledges the dialog — the status-bar banner keeps showing so the untrustworthy-sync state
// stays visible. Dismissing the banner is the stronger action and silences both surfaces.
const dialogAcknowledgedUserIds = new Set<string>();
const listeners = new Set<() => void>();

// Cached snapshots — useSyncExternalStore requires getSnapshot to return a referentially stable
// value between notifications, so we rebuild each only when its visible set actually changes.
let visibleSnapshot: string[] = [];
let dialogSnapshot: string[] = [];

function nextSnapshotFor(current: string[], excluded: Set<string>): string[] {
    const next = [...flaggedUserIds].filter((id) => !excluded.has(id));
    // Preserve reference identity when membership is unchanged (avoids a needless re-render loop).
    const isUnchanged = next.length === current.length && next.every((id, i) => id === current[i]);
    return isUnchanged ? current : next;
}

function recomputeSnapshots(): void {
    const nextVisible = nextSnapshotFor(visibleSnapshot, dismissedUserIds);
    const nextDialog = nextSnapshotFor(dialogSnapshot, dialogAcknowledgedUserIds);
    if (nextVisible === visibleSnapshot && nextDialog === dialogSnapshot) {
        return;
    }
    visibleSnapshot = nextVisible;
    dialogSnapshot = nextDialog;
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
    recomputeSnapshots();
}

/** Dismisses the banner for `userId` for the rest of this session, surviving the orchestrator's re-dispatches. */
export function dismissAccountReauth(userId: string): void {
    if (dismissedUserIds.has(userId)) {
        return;
    }
    dismissedUserIds.add(userId);
    // Banner dismissal is the stronger action — it must also stop the blocking dialog re-opening.
    dialogAcknowledgedUserIds.add(userId);
    recomputeSnapshots();
}

/**
 * Closes the blocking dialog for `userId` for the rest of this session ("Not now" / Escape). The
 * status-bar banner intentionally keeps showing — the app is not trustworthy while sync is down,
 * so acknowledging the dialog must not remove every trace of the warning.
 */
export function acknowledgeAccountReauthDialog(userId: string): void {
    if (dialogAcknowledgedUserIds.has(userId)) {
        return;
    }
    dialogAcknowledgedUserIds.add(userId);
    recomputeSnapshots();
}

/**
 * Removes every trace of `userId`'s reauth state in THIS tab — flag, banner dismissal, and dialog
 * acknowledgement. Dropping the dismissal tiers too is deliberate: a *future* breakage of the same
 * account is a new incident and must re-alert with the full dialog, not start pre-silenced.
 */
export function clearAccountReauth(userId: string): void {
    const wasFlagged = flaggedUserIds.delete(userId);
    dismissedUserIds.delete(userId);
    dialogAcknowledgedUserIds.delete(userId);
    // Dismissal tiers only affect rendering while a flag exists, so snapshots can only have
    // changed when the flag itself was removed.
    if (wasFlagged) {
        recomputeSnapshots();
    }
}

/**
 * Whether `userId` currently has an active reauth flag. Sync callers snapshot this BEFORE a pass
 * starts so a success only clears a flag that predates the pass — a flag raised concurrently
 * (e.g. by the Service Worker's postMessage relay) reports a NEW failure and must survive.
 */
export function isAccountFlaggedForReauth(userId: string): boolean {
    return flaggedUserIds.has(userId);
}

// Cross-tab "resolved" signal. A re-login (or a sync pass that succeeds again) in one tab must
// close the reauth dialog/banner in every other open tab — each tab's orchestrator flagged its own
// module store, and without this the stale dialog lingers there until a manual reload.
export const REAUTH_RESOLVED_STORAGE_KEY = 'gtd:accountReauthResolved';

/**
 * Announces that `userId` can sync again: clears this tab's state and notifies all other tabs via
 * the `storage` event (which only fires in OTHER tabs — the writer already cleared itself).
 */
export function announceAccountReauthResolved(userId: string): void {
    clearAccountReauth(userId);
    if (typeof localStorage === 'undefined') {
        return; // Node test env / SW — nothing to broadcast to
    }
    try {
        // Unique payload per write — the storage event only fires when the stored value changes, so
        // a bare userId would go silent on a second resolution of the same account.
        localStorage.setItem(REAUTH_RESOLVED_STORAGE_KEY, JSON.stringify({ userId, ts: dayjs().valueOf() }));
    } catch {
        // Storage can be unavailable/full (e.g. Safari private mode). The broadcast is best-effort;
        // it must never break the caller — auth.callback sits on the post-OAuth critical path.
    }
}

/**
 * Sync-success hook: a completed flush+pull for a flagged user proves its session works again, so
 * the reauth warning is stale — clear it here and in every other tab. No-op (and no storage churn)
 * for the common case of a user that was never flagged. Callers must gate this on a flag snapshot
 * taken BEFORE the sync pass started (see isAccountFlaggedForReauth) so a flag raised mid-pass by
 * a concurrent failing path is never mistaken for a stale one.
 */
export function clearAccountReauthAfterSuccessfulSync(userId: string): void {
    if (!flaggedUserIds.has(userId)) {
        return;
    }
    announceAccountReauthResolved(userId);
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

/** useSyncExternalStore getSnapshot — the userIds the blocking dialog should currently show. */
export function getReauthDialogUserIds(): string[] {
    return dialogSnapshot;
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
    // Cross-tab resolved signal (same mechanism as hiddenAccounts.ts): fires only in tabs that did
    // NOT write the key, i.e. exactly the tabs still showing a stale reauth dialog/banner.
    window.addEventListener('storage', (event) => {
        if (event.key !== REAUTH_RESOLVED_STORAGE_KEY || !event.newValue) {
            return;
        }
        const userId = parseResolvedUserId(event.newValue);
        if (userId !== null) {
            clearAccountReauth(userId);
        }
    });
}

/** Extracts the userId from a resolved-signal storage payload; null on a malformed value. */
function parseResolvedUserId(rawPayload: string): string | null {
    try {
        const parsed: unknown = JSON.parse(rawPayload);
        if (typeof parsed !== 'object' || parsed === null || !('userId' in parsed)) {
            return null;
        }
        return typeof parsed.userId === 'string' ? parsed.userId : null;
    } catch {
        return null; // another app version wrote something unexpected — ignore rather than throw
    }
}

/** Test-only: clears the shared store between cases. */
export function resetAccountReauthStore(): void {
    flaggedUserIds.clear();
    dismissedUserIds.clear();
    dialogAcknowledgedUserIds.clear();
    visibleSnapshot = [];
    dialogSnapshot = [];
}

/**
 * Test-only: allows the bridge to re-install on a freshly stubbed window. Kept separate from
 * resetAccountReauthStore so store resets in jsdom tests can't stack duplicate listeners on the
 * real window.
 */
export function resetAccountReauthBridgeForTests(): void {
    bridgeInstalled = false;
}

// Self-install: the store must receive flag/resolved signals in any tab where it's imported —
// tying installation to which component chunk happens to load first proved fragile (see the
// cross-tab-bridge-install-in-render reviewer memory). No-op outside a browser.
ensureAccountReauthBridge();
