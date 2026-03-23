import { useState, useEffect, useCallback } from 'react'
import type { IDBPDatabase } from 'idb'
import type { MyDB, StoredAccount, OAuthProvider } from '../types/MyDB'
import { getAllAccounts, getActiveAccount, removeAccount, clearAllAccounts, setActiveAccount } from '../db/accountHelpers'
import { authClient } from '../lib/authClient'

export interface AccountsState {
    activeAccount: StoredAccount | undefined
    allAccounts: StoredAccount[]
    addAnotherAccount: (provider: OAuthProvider) => void
    switchToAccount: (userId: string) => Promise<void>
    signOutCurrent: () => Promise<void>
    signOutAll: () => Promise<void>
}

export function useAccounts(db: IDBPDatabase<MyDB>): AccountsState {
    const [activeAccount, setActiveAccountState] = useState<StoredAccount | undefined>(undefined)
    const [allAccounts, setAllAccounts] = useState<StoredAccount[]>([])

    useEffect(() => {
        async function load() {
            // Sync IDB account cache from the server's list of active device sessions so
            // accounts added on other tabs / after page reload are always reflected.
            const { data: sessions } = await authClient.multiSession.listDeviceSessions()
            if (sessions) {
                const { upsertAccount } = await import('../db/accountHelpers')
                await Promise.all(
                    sessions.map((s) =>
                        upsertAccount(
                            {
                                id: s.user.id,
                                email: s.user.email,
                                name: s.user.name,
                                image: s.user.image ?? null,
                                provider: (s.user as { provider?: OAuthProvider }).provider ?? 'google',
                                addedAt: new Date(s.session.createdAt).getTime(),
                            },
                            db,
                        ),
                    ),
                )
            }

            const [all, active] = await Promise.all([getAllAccounts(db), getActiveAccount(db)])
            setAllAccounts(all)
            setActiveAccountState(active)
        }
        void load()
    }, [db])

    const addAnotherAccount = useCallback((provider: OAuthProvider) => {
        // Use disableRedirect=true to get the raw OAuth URL so we can manually append
        // prompt=select_account for Google. Without this, Google auto-selects the current
        // signed-in account and the OAuth completes instantly with no account picker shown.
        // Better Auth has no per-request prompt option in signIn.social's body schema.
        void authClient.signIn.social({
            provider,
            callbackURL: `${window.location.origin}/auth/callback`,
            disableRedirect: true,
        }).then(({ data }) => {
            if (!data?.url) return
            const url = new URL(data.url)
            if (provider === 'google') url.searchParams.set('prompt', 'select_account')
            window.location.href = url.toString()
        })
    }, [])

    const switchToAccount = useCallback(
        async (userId: string) => {
            const { data: sessions } = await authClient.multiSession.listDeviceSessions()
            const target = sessions?.find((s) => s.user.id === userId)

            if (!target) {
                // Session expired — fall back to OAuth re-authentication
                const account = allAccounts.find((a) => a.id === userId)
                if (!account) return
                void authClient.signIn.social({
                    provider: account.provider,
                    callbackURL: `${window.location.origin}/auth/callback`,
                })
                return
            }

            // Switch the active session cookie server-side — no OAuth redirect needed
            await authClient.multiSession.setActiveSession({ sessionToken: target.session.token })
            await setActiveAccount(userId, db)

            const [all, active] = await Promise.all([getAllAccounts(db), getActiveAccount(db)])
            setAllAccounts(all)
            setActiveAccountState(active)
        },
        [db, allAccounts],
    )

    const signOutCurrent = useCallback(async () => {
        await authClient.signOut()
        if (activeAccount) {
            await removeAccount(activeAccount.id, db)
        }
        const remaining = await getAllAccounts(db)
        if (remaining.length > 0 && remaining[0]) {
            // Auto-switch to the next available account
            void authClient.signIn.social({
                provider: remaining[0].provider,
                callbackURL: `${window.location.origin}/auth/callback`,
            })
        } else {
            window.location.href = '/login'
        }
    }, [db, activeAccount])

    const signOutAll = useCallback(async () => {
        await authClient.signOut()
        await clearAllAccounts(db)
        window.location.href = '/login'
    }, [db])

    return { activeAccount, allAccounts, addAnotherAccount, switchToAccount, signOutCurrent, signOutAll }
}
