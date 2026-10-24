/**
 * Decisions a tab makes when it hears `gtd:account-evaporated` (see `accountEvaporatedEvents.ts`),
 * kept free of React so they are unit-testable without rendering AppDataProvider.
 */
import dayjs from 'dayjs';
import { hasAtLeastOne } from '../lib/typeUtils';

/**
 * The account a tab rendered at boot (`AppData.account`) is sticky for the tab's lifetime — the
 * provider never re-reads it. If ANOTHER tab evaporated that account first and moved the IDB active
 * pointer to a survivor, this tab's own evaporation sees `wasActive=false` and a live active account,
 * so it never navigates — yet it would keep rendering the deleted account and queueing ops under it.
 * Only a reload boots the tab onto the survivor.
 */
export function shouldReloadOnEvaporation(evaporatedUserId: string, tabAccountId: string | null): boolean {
    return tabAccountId !== null && evaporatedUserId === tabAccountId;
}

/**
 * Belt-and-braces for a tab that missed every evaporation signal (SSE lost while frozen, broadcast
 * not delivered): after a sync pass, a boot-time account that is no longer in IDB's account list
 * was removed by another tab (deleted, or signed out there) — this tab must reload rather than
 * keep rendering it and queueing orphan ops.
 */
export function shouldReloadForMissingAccount(tabAccountId: string | null, loggedInUserIds: readonly string[]): boolean {
    return tabAccountId !== null && !loggedInUserIds.includes(tabAccountId);
}

export type ReloadDestination = '/' | '/login';

/**
 * Where a tab that must leave its (now deleted) account reloads to. `/` is the PUBLIC landing page,
 * so it is only right while another account remains signed in on the device; with none left the
 * tab goes straight to `/login`. Every reload path uses this so two tabs racing each other (each
 * evaporates and broadcasts; each hears the other's broadcast) agree on the destination instead of
 * one tab's `/` clobbering the other's `/login`.
 */
export function reloadDestination(remainingUserIds: string[]): ReloadDestination {
    return hasAtLeastOne(remainingUserIds) ? '/' : '/login';
}

export interface TabAccountGoneDeps {
    /** The account this tab rendered at boot (`AppData.account`), sticky for the tab's lifetime. */
    tabAccountId: string | null;
    /** IDB read of the accounts still signed in on the device (`getLoggedInUserIds`). */
    readLoggedInUserIds: () => Promise<string[]>;
    /**
     * Reload only when NOBODY is left. Used where a missing active pointer with survivors present is
     * the transient mid-evaporation window of another tab — its broadcast (sent once the pivot is
     * written) will tell this tab where to go; reloading now would race that pivot.
     */
    onlyWhenNoneRemain?: boolean;
    navigate: (destination: ReloadDestination) => void;
}

/**
 * Set while this tab runs its own account action (sign-out, switch). Such an action removes the
 * account from IDB before its server call and ends in its own navigation; a sync pass finishing in
 * between would otherwise see the account gone and navigate first — cancelling the sign-out
 * request and leaving the user signed in. Bounded in time: a "successful" action whose navigation
 * never happened (a fire-and-forget re-auth that failed, a beforeunload prompt answered with Stay)
 * must not switch the check off for the rest of the tab's life. 30s outlasts a stalled sign-out.
 */
const LOCAL_ACCOUNT_ACTION_HOLD_MS = 30_000;
const localAccountAction: { heldSinceMs: number | null } = { heldSinceMs: null };

function isLocalAccountActionHeld(): boolean {
    return localAccountAction.heldSinceMs !== null && dayjs().valueOf() - localAccountAction.heldSinceMs < LOCAL_ACCOUNT_ACTION_HOLD_MS;
}

/**
 * Runs an account action that owns the tab's next navigation. Success leaves the hold in place on
 * purpose (the action navigates away); a failure hands the tab back to the "account gone" check.
 */
export async function runLocalAccountAction<T>(action: () => Promise<T>): Promise<T> {
    localAccountAction.heldSinceMs = dayjs().valueOf();
    try {
        return await action();
    } catch (err) {
        localAccountAction.heldSinceMs = null;
        throw err;
    }
}

/** Test-only: release the hold a successful action leaves behind. */
export function __resetLocalAccountActionForTests(): void {
    localAccountAction.heldSinceMs = null;
}

/**
 * The one reload decision every "my account vanished" path shares: read the surviving accounts,
 * leave if this tab's account is still among them, otherwise navigate to `reloadDestination`.
 * Returns the destination taken, or null when the tab stays.
 */
export async function reloadIfTabAccountGone(deps: TabAccountGoneDeps): Promise<ReloadDestination | null> {
    if (isLocalAccountActionHeld()) {
        return null;
    }
    const remaining = await deps.readLoggedInUserIds();
    if (!shouldReloadForMissingAccount(deps.tabAccountId, remaining)) {
        return null;
    }
    if (deps.onlyWhenNoneRemain && hasAtLeastOne(remaining)) {
        return null;
    }
    const destination = reloadDestination(remaining);
    deps.navigate(destination);
    return destination;
}

export interface EvaporationRefreshDeps {
    /** Re-reads the account list from IDB into the provider (AppDataProvider.refreshAccountsInternal). */
    refreshAccounts: () => Promise<unknown>;
    getDeviceId: () => Promise<string>;
    /** False once the provider unmounted while the reads above were in flight. */
    isStillMounted: () => boolean;
    isOnline: () => boolean;
    /** Re-opens SSE with the surviving ids — `openSseConnections` closes the evaporated channel itself. */
    reopenSse: (deviceId: string) => void;
    refreshResources: () => void;
}

export type EvaporationRefreshOutcome = 'reopened' | 'offline' | 'unmounted';

/**
 * A non-active account was evaporated: refresh the account list, then — if this tab is still
 * mounted — re-open SSE for the survivors (online only; the online effect reopens later otherwise)
 * and refresh every resource so the deleted account's rows vanish from unified views.
 */
export async function refreshAfterAccountEvaporation(deps: EvaporationRefreshDeps): Promise<EvaporationRefreshOutcome> {
    await deps.refreshAccounts();
    const deviceId = await deps.getDeviceId();
    // The boot cleanup's closeSseConnections() may have run while the reads above were in flight;
    // reopening after it would leak channels nothing closes.
    if (!deps.isStillMounted()) {
        return 'unmounted';
    }
    const outcome = deps.isOnline() ? 'reopened' : 'offline';
    if (outcome === 'reopened') {
        deps.reopenSse(deviceId);
    }
    deps.refreshResources();
    return outcome;
}
