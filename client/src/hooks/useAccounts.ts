import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { useCallback, useEffect, useState } from 'react';
import { signOutDevice } from '../api/pushApi';
import { clearAllAccounts, getActiveAccount, getAllAccounts, removeAccount, setActiveAccount, wipeUserData } from '../db/accountHelpers';
import { getOrCreateDeviceId } from '../db/deviceId';
import { authClient } from '../lib/authClient';
import type { MyDB, OAuthProvider, StoredAccount } from '../types/MyDB';

export type PendingAction = 'switching' | 'signingOut' | 'signingOutAll';

const FAILURE_LABELS: Record<PendingAction, string> = {
    switching: "Couldn't switch account. Please try again.",
    signingOut: "Couldn't sign out. Please try again.",
    signingOutAll: "Couldn't sign out of all accounts. Please try again.",
};

export interface AccountsState {
    activeAccount: StoredAccount | undefined;
    allAccounts: StoredAccount[];
    addAnotherAccount: (provider: OAuthProvider) => void;
    switchToAccount: (userId: string) => Promise<void>;
    /**
     * Kicks off an OAuth re-login redirect for a logged-in account whose Better Auth session is
     * missing/expired. Returns true when navigation started, false when the account isn't known
     * locally. Surfaced so the AccountReauthBanner can recover the silent-skip case (Bug B).
     */
    reauthForUserId: (userId: string) => boolean;
    signOutCurrent: () => Promise<void>;
    signOutAll: () => Promise<void>;
    pendingAction: PendingAction | null;
    actionError: string | null;
    dismissActionError: () => void;
}

/**
 * Pure core of the local-first account switch, extracted so its failure contract is testable
 * without a DOM (same precedent as `startReauthForAccount`). Persists the choice to IDB and
 * returns the URL to hard-reload to. A rejecting IDB write MUST propagate — `withPending`'s catch
 * is what clears the blocking backdrop and surfaces the "Couldn't switch" error; swallowing here
 * would strand the user behind the backdrop.
 */
export async function performLocalAccountSwitch(db: IDBPDatabase<MyDB>, userId: string, currentUrl: { pathname: string; search: string }): Promise<string> {
    await setActiveAccount(userId, db);
    return currentUrl.pathname + currentUrl.search;
}

/**
 * Pure core of `reauthForUserId`, extracted so it's testable without a DOM. Looks up the account by
 * id and, if found, invokes `startSignIn` with it — returning whether a re-auth was kicked off. The
 * `startSignIn` callback is injected so tests can assert the target account without driving a real
 * OAuth redirect.
 */
export function startReauthForAccount(accounts: StoredAccount[], userId: string, startSignIn: (account: StoredAccount) => void): boolean {
    const account = accounts.find((a) => a.id === userId);
    if (!account) {
        return false;
    }
    startSignIn(account);
    return true;
}

export function useAccounts(db: IDBPDatabase<MyDB>): AccountsState {
    const [activeAccount, setActiveAccountState] = useState<StoredAccount | undefined>(undefined);
    const [allAccounts, setAllAccounts] = useState<StoredAccount[]>([]);
    const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);

    const dismissActionError = useCallback(() => setActionError(null), []);

    // Wraps the three account-mutation actions in one place: clear the prior error, set the
    // pending label, and on rejection clear pending + surface a user-visible message. Success
    // paths always end in window.location navigation, so explicit "clear pending on success"
    // would be dead code.
    const withPending = useCallback(async <T>(action: PendingAction, fn: () => Promise<T>): Promise<T | undefined> => {
        setActionError(null);
        setPendingAction(action);
        try {
            return await fn();
        } catch (err) {
            console.error(`Account action "${action}" failed`, err);
            setPendingAction(null);
            setActionError(FAILURE_LABELS[action]);
            return undefined;
        }
    }, []);

    useEffect(() => {
        async function load() {
            // Sync IDB account cache from the server's list of active device sessions so
            // accounts added on other tabs / after page reload are always reflected.
            // Skip gracefully when offline — IDB cache will still have the last known accounts.
            try {
                const { data: sessions } = await authClient.multiSession.listDeviceSessions();
                if (sessions) {
                    const { upsertAccount } = await import('../db/accountHelpers');
                    await Promise.all(
                        sessions.map((s) =>
                            upsertAccount(
                                {
                                    id: s.user.id,
                                    email: s.user.email,
                                    name: s.user.name,
                                    image: s.user.image ?? null,
                                    // Better Auth's session type omits provider — cast to access the field persisted at sign-in
                                    provider: (s.user as { provider?: OAuthProvider }).provider ?? 'google',
                                    addedAt: dayjs(s.session.createdAt).valueOf(),
                                },
                                db,
                            ),
                        ),
                    );
                }
            } catch {
                // Offline or server unreachable — fall through to load from IDB cache
            }

            const [all, active] = await Promise.all([getAllAccounts(db), getActiveAccount(db)]);
            setAllAccounts(all);
            setActiveAccountState(active);
        }
        void load();
    }, [db]);

    const addAnotherAccount = useCallback((provider: OAuthProvider) => {
        // Use disableRedirect=true to get the raw OAuth URL so we can manually append
        // prompt=select_account for Google. Without this, Google auto-selects the current
        // signed-in account and the OAuth completes instantly with no account picker shown.
        // Better Auth has no per-request prompt option in signIn.social's body schema.
        void authClient.signIn
            .social({
                provider,
                callbackURL: `${window.location.origin}/auth/callback`,
                disableRedirect: true,
            })
            .then(({ data }) => {
                if (!data?.url) return;
                const url = new URL(data.url);
                if (provider === 'google') url.searchParams.set('prompt', 'select_account');
                window.location.href = url.toString();
            });
    }, []);

    const reauthForUserId = useCallback(
        (userId: string): boolean =>
            // Session expired — trigger OAuth re-authentication for the target account. Returns true
            // when navigation was kicked off, false when the account isn't known locally (caller is
            // responsible for clearing any pending UI state). Core logic lives in startReauthForAccount.
            startReauthForAccount(allAccounts, userId, (account) => {
                void authClient.signIn
                    .social({
                        provider: account.provider,
                        callbackURL: `${window.location.origin}/auth/callback`,
                        disableRedirect: true,
                    })
                    .then(({ data }) => {
                        if (!data?.url) return;
                        const url = new URL(data.url);
                        if (account.provider === 'google') {
                            // Re-login must land on the SAME account that broke. Without these,
                            // Google silently completes as whichever account is currently signed in
                            // to the browser — leaving the broken account still broken while the
                            // callback announces a resolution for the wrong one.
                            url.searchParams.set('prompt', 'select_account');
                            url.searchParams.set('login_hint', account.email);
                        }
                        window.location.href = url.toString();
                    });
            }),
        [allAccounts],
    );

    const switchToAccount = useCallback(
        async (userId: string) => {
            await withPending('switching', async () => {
                // Local-first is the ONLY path: switching the app's active account is an IDB write
                // plus a hard reload — no network round-trip, so it works fully offline (the app
                // renders the target account's cached data from IDB). The server-side Better Auth
                // active-session cookie is reconciled to IDB asynchronously by
                // `reconcileActiveSessionCookie` (AppDataProvider's boot + online paths); if the
                // target's session turns out to be expired, that reconcile dispatches the reauth
                // dialog — an informative surface, instead of blocking the switch here.
                // The hard reload back to the current route makes AppDataProvider re-run its boot
                // effect so every component reads the new active account. Without it,
                // useAppData().account stays stuck on the previous account — Settings shows stale
                // name/email, and worse, mutations get written under the wrong userId. Matches the
                // reload pattern already used by signOutCurrent and switchToNextAndRevoke.
                window.location.href = await performLocalAccountSwitch(db, userId, window.location);
            });
        },
        [db, withPending],
    );

    const switchToNextAndRevoke = useCallback(
        async (next: StoredAccount, currentSessionToken: string | undefined, targetSessionToken: string) => {
            // Drop the about-to-be-signed-out (deviceId, currentUserId) join row BEFORE switching
            // active session — once we switch, the auth middleware can no longer identify
            // "currentUser" by cookie alone. Order matters: signoutDevice authenticates via
            // the still-active current session.
            const deviceId = await getOrCreateDeviceId(db);
            await signOutDevice(deviceId);
            // Switch first so we have an active session — multiSession.revoke validates
            // ownership via the device multi-session cookie (not userId), so it can revoke
            // the old session even though we're now authenticated as the next user.
            await authClient.multiSession.setActive({ sessionToken: targetSessionToken });
            await setActiveAccount(next.id, db);
            if (currentSessionToken) {
                await authClient.multiSession.revoke({ sessionToken: currentSessionToken });
            }
            window.location.href = '/';
        },
        [db],
    );

    const reauthAsNext = useCallback((next: StoredAccount) => {
        // Session expired — sign out current session and re-authenticate via OAuth
        void authClient.signOut().then(() => {
            void authClient.signIn.social({
                provider: next.provider,
                callbackURL: `${window.location.origin}/auth/callback`,
            });
        });
    }, []);

    const revokeCurrentFromIDB = useCallback(async () => {
        // Fetches sessions and removes the current account from IDB in one step,
        // returning both the session list (needed by the caller for transfer) and
        // the current session token (needed to revoke it after switching).
        const { data: sessions } = await authClient.multiSession.listDeviceSessions();
        const currentSession = sessions?.find((s) => s.user.id === activeAccount?.id);
        if (activeAccount) {
            // Wipe before removeAccount so we still know which userId's rows to drop.
            // Note: this also drops any unflushed `syncOperations` queued for this user — a user
            // who signs out while offline with pending mutations loses them. The alternative is
            // leaving them in IDB indefinitely with no UI to recover them, which is worse.
            await wipeUserData(activeAccount.id, db);
            await removeAccount(activeAccount.id, db);
        }
        return { currentSessionToken: currentSession?.session.token, sessions };
    }, [db, activeAccount]);

    const signOutCurrent = useCallback(async () => {
        await withPending('signingOut', async () => {
            const { currentSessionToken, sessions } = await revokeCurrentFromIDB();

            const remaining = await getAllAccounts(db);
            const next = remaining[0];

            if (!next) {
                // Drop the (deviceId, currentUserId) join row before authClient.signOut — the
                // signoutDevice endpoint authenticates via the still-active current session.
                const deviceId = await getOrCreateDeviceId(db);
                await signOutDevice(deviceId);
                await authClient.signOut();
                window.location.href = '/login';
                return;
            }

            const targetSession = sessions?.find((s) => s.user.id === next.id);
            if (targetSession) {
                await switchToNextAndRevoke(next, currentSessionToken, targetSession.session.token);
            } else {
                reauthAsNext(next);
            }
        });
    }, [db, revokeCurrentFromIDB, switchToNextAndRevoke, reauthAsNext, withPending]);

    const signOutAll = useCallback(async () => {
        await withPending('signingOutAll', async () => {
            // Best-effort: drop the (deviceId, activeUserId) join row before Better Auth tears down
            // every session on this device. Other accounts' join rows fall through to the
            // 410-on-push and stale-device cleanup paths.
            const deviceId = await getOrCreateDeviceId(db);
            await signOutDevice(deviceId);
            await authClient.signOut();
            // Wipe each account's IDB rows before clearing the account directory itself —
            // accounts read first so userIds are in hand, then per-user wipe, then the directory.
            const accounts = await getAllAccounts(db);
            await Promise.all(accounts.map((a) => wipeUserData(a.id, db)));
            await clearAllAccounts(db);
            window.location.href = '/login';
        });
    }, [db, withPending]);

    return {
        activeAccount,
        allAccounts,
        addAnotherAccount,
        switchToAccount,
        reauthForUserId,
        signOutCurrent,
        signOutAll,
        pendingAction,
        actionError,
        dismissActionError,
    };
}
