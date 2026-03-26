import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { useCallback, useEffect, useState } from 'react';
import { clearAllAccounts, getActiveAccount, getAllAccounts, removeAccount, setActiveAccount } from '../db/accountHelpers';
import { authClient } from '../lib/authClient';
import type { MyDB, OAuthProvider, StoredAccount } from '../types/MyDB';

export interface AccountsState {
    activeAccount: StoredAccount | undefined;
    allAccounts: StoredAccount[];
    addAnotherAccount: (provider: OAuthProvider) => void;
    switchToAccount: (userId: string) => Promise<void>;
    signOutCurrent: () => Promise<void>;
    signOutAll: () => Promise<void>;
}

export function useAccounts(db: IDBPDatabase<MyDB>): AccountsState {
    const [activeAccount, setActiveAccountState] = useState<StoredAccount | undefined>(undefined);
    const [allAccounts, setAllAccounts] = useState<StoredAccount[]>([]);

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

    const switchToAccount = useCallback(
        async (userId: string) => {
            const { data: sessions } = await authClient.multiSession.listDeviceSessions();
            const target = sessions?.find((s) => s.user.id === userId);

            if (!target) {
                // Session expired — fall back to OAuth re-authentication
                const account = allAccounts.find((a) => a.id === userId);
                if (!account) return;
                void authClient.signIn.social({
                    provider: account.provider,
                    callbackURL: `${window.location.origin}/auth/callback`,
                });
                return;
            }

            // Switch the active session cookie server-side — no OAuth redirect needed
            await authClient.multiSession.setActive({ sessionToken: target.session.token });
            await setActiveAccount(userId, db);

            const [all, active] = await Promise.all([getAllAccounts(db), getActiveAccount(db)]);
            setAllAccounts(all);
            setActiveAccountState(active);
        },
        [db, allAccounts],
    );

    const switchToNextAndRevoke = useCallback(
        async (next: StoredAccount, currentSessionToken: string | undefined, targetSessionToken: string) => {
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

    const signOutCurrent = useCallback(async () => {
        const { data: sessions } = await authClient.multiSession.listDeviceSessions();
        const currentSession = sessions?.find((s) => s.user.id === activeAccount?.id);

        if (activeAccount) {
            await removeAccount(activeAccount.id, db);
        }

        const remaining = await getAllAccounts(db);
        const next = remaining[0];

        if (!next) {
            await authClient.signOut();
            window.location.href = '/login';
            return;
        }

        const targetSession = sessions?.find((s) => s.user.id === next.id);
        if (targetSession) {
            await switchToNextAndRevoke(next, currentSession?.session.token, targetSession.session.token);
        } else {
            reauthAsNext(next);
        }
    }, [db, activeAccount, switchToNextAndRevoke, reauthAsNext]);

    const signOutAll = useCallback(async () => {
        await authClient.signOut();
        await clearAllAccounts(db);
        window.location.href = '/login';
    }, [db]);

    return { activeAccount, allAccounts, addAnotherAccount, switchToAccount, signOutCurrent, signOutAll };
}
