import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { createContext, type PropsWithChildren, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { listIntegrations, syncIntegration } from '../api/calendarApi';
import { AppResourceProvider } from '../data/AppResourceProvider';
import { getActiveAccount, getLoggedInAccounts, upsertAccount } from '../db/accountHelpers';
import { getOrCreateDeviceId } from '../db/deviceId';
import { getItemsAcrossUsers } from '../db/itemHelpers';
import { syncAllLoggedInUsers, syncSingleUser } from '../db/multiUserSync';
import { getPeopleAcrossUsers } from '../db/personHelpers';
import { registerPushSubscriptionIfPermitted } from '../db/pushSubscription';
import { getRoutinesAcrossUsers } from '../db/routineHelpers';
import { materializePendingNextActionRoutines } from '../db/routineItemHelpers';
import { closeSseConnections, openSseConnections } from '../db/sseClient';
import { flushSyncQueue, pullFromServer } from '../db/syncHelpers';
import { getWorkContextsAcrossUsers } from '../db/workContextHelpers';
import { useOnline } from '../hooks/useOnline';
import { authClient } from '../lib/authClient';
import type { MyDB, OAuthProvider, StoredAccount, StoredItem, StoredPerson, StoredRoutine, StoredWorkContext } from '../types/MyDB';
import { applyOverrideToItem, applyOverrideToRoutine, usePendingReassignMaps } from './PendingReassignProvider';

export interface AppData {
    /** The active session's account — the default-owner for newly created entities. */
    account: StoredAccount | null;
    /**
     * Every account currently signed in on this device. Reads in unified-view paths span all of
     * these, but mutations still write under `account.id`. Stays empty until the boot effect
     * loads accounts from IDB.
     */
    loggedInAccounts: StoredAccount[];
    /** Convenience: same as `loggedInAccounts.map(a => a.id)`. Memoized at the provider level. */
    loggedInUserIds: string[];
    items: StoredItem[];
    workContexts: StoredWorkContext[];
    people: StoredPerson[];
    routines: StoredRoutine[];
    /**
     * True until the first IDB cache read completes on mount. List pages use this to render a
     * loading state instead of their empty-state during the brief gap between component mount
     * and `initializeFromCache` populating React state — otherwise a hard refresh briefly shows
     * "no items" before the cached items appear.
     */
    isInitialLoading: boolean;
    refreshItems: () => Promise<void>;
    refreshWorkContexts: () => Promise<void>;
    refreshPeople: () => Promise<void>;
    refreshRoutines: () => Promise<void>;
    /** Re-reads accounts from IDB after a sign-in/out. Triggers refreshes for unified-view consumers. */
    refreshAccounts: () => Promise<void>;
    syncAndRefresh: () => Promise<void>;
}

// Exported so Storybook stories can provide a mock AppData value directly.
// biome-ignore lint/style/noNonNullAssertion: Context is initialized with a non-null default value and only used within the provider, so this is safe.
export const AppDataContext = createContext<AppData>(undefined!);

export function useAppData(): AppData {
    return useContext(AppDataContext);
}

async function syncCalendarIntegrationsForActiveSession(): Promise<void> {
    // Reads through the active Better Auth session — the caller (multiUserSync) pivots the active
    // session per user, so this implicitly scopes the listed integrations to that user.
    const integrations = await listIntegrations().catch(() => []);
    // Fire-and-forget each integration — a single calendar failure shouldn't block the rest.
    await Promise.allSettled(integrations.map((i) => syncIntegration(i._id)));
}

export function AppDataProvider({ db, children }: PropsWithChildren<{ db: IDBPDatabase<MyDB> }>) {
    const [account, setAccount] = useState<StoredAccount | null>(null);
    const [loggedInAccounts, setLoggedInAccounts] = useState<StoredAccount[]>([]);
    const [items, setItems] = useState<StoredItem[]>([]);
    const [workContexts, setWorkContexts] = useState<StoredWorkContext[]>([]);
    const [people, setPeople] = useState<StoredPerson[]>([]);
    const [routines, setRoutines] = useState<StoredRoutine[]>([]);
    // Flips to false once loadAll has finished its initial IDB read (or determined there's no
    // active account). Routes use this to distinguish "still loading" from "loaded, genuinely empty".
    const [isInitialLoading, setIsInitialLoading] = useState(true);
    const isOnline = useOnline();
    const isFirstOnlineRender = useRef(true); // Skips the first render of the isOnline effect — mount-time handling is done in loadAll()

    // Cached id list — stable identity when the account ids didn't change so consumers
    // memoizing on it don't re-run for every accounts-array re-creation.
    const loggedInUserIds = useMemo(() => loggedInAccounts.map((a) => a.id), [loggedInAccounts]);

    // Mirror state into a ref so the refresh* callbacks can read the freshest list
    // without depending on `loggedInAccounts` (whose change would re-create every callback
    // and ripple through child memoization). useEffect below keeps the ref synced.
    const loggedInUserIdsRef = useRef<string[]>([]);
    useEffect(() => {
        loggedInUserIdsRef.current = loggedInUserIds;
    }, [loggedInUserIds]);

    const refreshItems = useCallback(async () => {
        setItems(await getItemsAcrossUsers(db, loggedInUserIdsRef.current));
    }, [db]);
    const refreshWorkContexts = useCallback(async () => {
        setWorkContexts(await getWorkContextsAcrossUsers(db, loggedInUserIdsRef.current));
    }, [db]);
    const refreshPeople = useCallback(async () => {
        setPeople(await getPeopleAcrossUsers(db, loggedInUserIdsRef.current));
    }, [db]);
    const refreshRoutines = useCallback(async () => {
        setRoutines(await getRoutinesAcrossUsers(db, loggedInUserIdsRef.current));
    }, [db]);

    // Mirrors Better Auth's device-multi-session list into the IDB `accounts` store before
    // reading from it. Without this seed, only the active session's account row exists at boot
    // (auth.callback.tsx hydrates one), so SSE would open only one channel on a multi-account
    // device. Skips silently when offline — the IDB cache then represents the last known state.
    const seedAccountsFromMultiSession = useCallback(async (): Promise<void> => {
        try {
            const { data: sessions } = await authClient.multiSession.listDeviceSessions();
            if (!sessions) {
                return;
            }
            await Promise.all(
                sessions.map((s) =>
                    upsertAccount(
                        {
                            id: s.user.id,
                            email: s.user.email,
                            name: s.user.name,
                            image: s.user.image ?? null,
                            // Better Auth's session type omits provider — cast to access the field persisted at sign-in.
                            provider: (s.user as { provider?: OAuthProvider }).provider ?? 'google',
                            addedAt: dayjs(s.session.createdAt).valueOf(),
                        },
                        db,
                    ),
                ),
            );
        } catch {
            // Offline or server unreachable — fall through to load from IDB cache.
        }
    }, [db]);

    // Re-reads accounts from IDB so add/remove-account flows can drive a unified-view
    // refresh without driving a full sync round-trip. Returns the freshly read list so
    // consumers (e.g. boot/online effects) can chain entity refreshes off the new ids.
    const refreshAccounts = useCallback(async (): Promise<StoredAccount[]> => {
        await seedAccountsFromMultiSession();
        const accounts = await getLoggedInAccounts(db);
        setLoggedInAccounts(accounts);
        loggedInUserIdsRef.current = accounts.map((a) => a.id);
        return accounts;
    }, [db, seedAccountsFromMultiSession]);

    // Guards against concurrent invocations from three independent paths: boot effect,
    // SSE callback, and SW push message. flushSyncQueue/pullFromServer have their own
    // module-level guards, but this prevents redundant IDB reads and setState batches.
    const isSyncingRef = useRef(false);
    // When an SSE/push event arrives while syncAndRefresh is already running, setting this
    // flag ensures a follow-up sync runs after the current one finishes. Without it, the
    // incoming event would be silently dropped and the user wouldn't see the update.
    const syncRequestedWhileBusy = useRef(false);
    // Prevents setState calls from in-flight syncAndRefresh/initializeFromCache after unmount
    // (e.g. React Strict Mode double-mount, or fast navigation away during a network round-trip).
    const unmountedRef = useRef(false);

    // Reads every entity store once across all logged-in users and pushes the result into
    // React state. Extracted so syncAndRefresh and the catch-up pull share one definition
    // and so each call is a single concise level of abstraction.
    const refreshAllEntitiesAcrossUsers = useCallback(async () => {
        const userIds = loggedInUserIdsRef.current;
        const [freshItems, freshWorkContexts, freshPeople, freshRoutines] = await Promise.all([
            getItemsAcrossUsers(db, userIds),
            getWorkContextsAcrossUsers(db, userIds),
            getPeopleAcrossUsers(db, userIds),
            getRoutinesAcrossUsers(db, userIds),
        ]);
        setItems(freshItems);
        setWorkContexts(freshWorkContexts);
        setPeople(freshPeople);
        setRoutines(freshRoutines);
    }, [db]);

    // Extracted so both the mount effect and the isOnline effect can call it.
    const syncAndRefresh = useCallback(async () => {
        console.log('[debug-gcal-sync][client] syncAndRefresh called', { isSyncing: isSyncingRef.current });
        if (isSyncingRef.current) {
            syncRequestedWhileBusy.current = true;
            console.log('[debug-gcal-sync][client] syncAndRefresh deferred — already syncing, will catch up');
            return;
        }
        isSyncingRef.current = true;
        try {
            const acct = await getActiveAccount(db);
            if (!acct) {
                console.log('[debug-gcal-sync][client] syncAndRefresh aborted — no active account');
                return;
            }

            console.log('[debug-gcal-sync][client] syncAndRefresh: per-user flush + pull + calendar sync');
            // Multi-account orchestrator: pivots active session per logged-in user, flushes that
            // user's queue, pulls (or bootstraps), then runs that user's calendar integrations.
            await syncAllLoggedInUsers(db, { onUserSynced: async () => syncCalendarIntegrationsForActiveSession() });

            // After pulling for the active account, materialize startDate-due routines so the
            // user sees today's first occurrence without waiting for the next disposal event.
            await materializePendingNextActionRoutines(db, acct.id);

            // Guard after the async work — component may have unmounted while awaiting network.
            if (unmountedRef.current) {
                console.log('[debug-gcal-sync][client] syncAndRefresh: unmounted — skipping setState');
                return;
            }
            await refreshAllEntitiesAcrossUsers();
        } finally {
            isSyncingRef.current = false;
            // If an SSE/push event arrived while we were syncing, do a lightweight catch-up
            // pull instead of a full syncAndRefresh. A full sync would run calendar integration
            // and two more pulls, creating race conditions with concurrent pushes. A single
            // multi-account orchestrated pull is sufficient — pulling only for the active user
            // would silently miss ops on other accounts' channels.
            if (syncRequestedWhileBusy.current) {
                syncRequestedWhileBusy.current = false;
                console.log('[debug-gcal-sync][client] running catch-up pull (event arrived during sync)');
                syncAllLoggedInUsers(db)
                    .then(async () => {
                        if (unmountedRef.current) return;
                        await refreshAllEntitiesAcrossUsers();
                    })
                    .catch((err) => console.error('[sync] catch-up pull failed:', err));
            }
        }
    }, [db, refreshAllEntitiesAcrossUsers]);

    // SSE callback receives the userId of the channel that fired. We trigger a per-user pull only —
    // re-syncing every account on every event would multiply network round-trips by N for no
    // benefit, since changes on user A's channel can't affect user B's data.
    //
    // Important: the per-user pull MUST run under that user's active Better Auth session so the
    // server returns ops for that user. When the fired channel matches the active session, we
    // pull directly. When it doesn't, we use `syncSingleUser` to pivot/flush/pull/restore for just
    // that one user — far cheaper than `syncAllLoggedInUsers` which would re-run every account.
    const onSseUpdateForUser = useCallback(
        (userId: string) => {
            void (async () => {
                try {
                    const activeAcct = await getActiveAccount(db);
                    if (activeAcct?.id === userId) {
                        await flushSyncQueue(db, { userIdFilter: userId });
                        await pullFromServer(db, userId);
                    } else {
                        await syncSingleUser(db, userId);
                    }
                    if (unmountedRef.current) return;
                    await refreshAllEntitiesAcrossUsers();
                } catch (err) {
                    console.error('[sse] per-user sync failed:', err);
                }
            })();
        },
        [db, refreshAllEntitiesAcrossUsers],
    );

    const initializeFromCache = useCallback(
        async (acct: StoredAccount, accounts: StoredAccount[]) => {
            // Show cached data immediately — works offline with no network round-trip.
            // Reads span every logged-in account so the unified view is correct from frame 1.
            const userIds = accounts.map((a) => a.id);
            const [items, workContexts, people, routines] = await Promise.all([
                getItemsAcrossUsers(db, userIds),
                getWorkContextsAcrossUsers(db, userIds),
                getPeopleAcrossUsers(db, userIds),
                getRoutinesAcrossUsers(db, userIds),
            ]);
            // Skip setState if the component unmounted while the IDB reads were in flight.
            if (unmountedRef.current) {
                return;
            }
            setAccount(acct);
            setItems(items);
            setWorkContexts(workContexts);
            setPeople(people);
            setRoutines(routines);
        },
        [db],
    );

    // When the SW handles a push event it updates IndexedDB and then messages open tabs.
    // Without this listener the tab only sees fresh data after the next mount.
    // db is initialized once in main.tsx and never changes, so syncAndRefresh has stable
    // identity for the full component lifetime — no ref indirection needed.
    const onSwMessage = useCallback(
        (event: MessageEvent) => {
            if (event.data?.type === 'sync-complete') {
                syncAndRefresh().catch((err) => console.error('[sw-push] sync failed:', err));
            }
        },
        [syncAndRefresh],
    );

    const loadAll = useCallback(async () => {
        const acct = await getActiveAccount(db);
        if (!acct) {
            // No account — nothing to load. Drop the flag so the UI moves past its loading state
            // (the route guard will redirect to /login, but if a child renders first it shouldn't
            // be stuck on a spinner).
            if (!unmountedRef.current) {
                setIsInitialLoading(false);
            }
            return;
        }
        // Refresh accounts BEFORE initializing from cache so cross-user reads see every
        // account; otherwise the very first render would only show the active account's
        // entities, then flicker once accounts loaded.
        const accounts = await refreshAccounts();
        await initializeFromCache(acct, accounts);
        // Cached data is now in React state — surface it to the UI immediately. The subsequent
        // server sync will update what's on screen rather than gating the first paint.
        if (!unmountedRef.current) {
            setIsInitialLoading(false);
        }
        if (!navigator.onLine) {
            return;
        }
        await syncAndRefresh();
    }, [db, initializeFromCache, refreshAccounts, syncAndRefresh]);

    // Cross-account reassign overlay: while a /sync/reassign is in flight the source-account row
    // is rewritten to render under the target account. Touches only fields safe to forge (userId
    // + calendar config refs); the underlying IDB row is unchanged. See PendingReassignProvider.
    const { items: itemOverrides, routines: routineOverrides } = usePendingReassignMaps();
    const visibleItems = useMemo(() => {
        if (itemOverrides.size === 0) {
            return items;
        }
        return items.map((item) => {
            const override = itemOverrides.get(item._id);
            return override ? applyOverrideToItem(item, override) : item;
        });
    }, [items, itemOverrides]);
    const visibleRoutines = useMemo(() => {
        if (routineOverrides.size === 0) {
            return routines;
        }
        return routines.map((routine) => {
            const override = routineOverrides.get(routine._id);
            return override ? applyOverrideToRoutine(routine, override) : routine;
        });
    }, [routines, routineOverrides]);

    const appData: AppData = useMemo(
        () => ({
            account,
            loggedInAccounts,
            loggedInUserIds,
            items: visibleItems,
            workContexts,
            people,
            routines: visibleRoutines,
            isInitialLoading,
            refreshItems,
            refreshWorkContexts,
            refreshPeople,
            refreshRoutines,
            // Cast away the extra accounts return value — consumers don't need it; the
            // internal call sites that do (loadAll) use it directly via refreshAccounts.
            refreshAccounts: async () => {
                await refreshAccounts();
            },
            syncAndRefresh,
        }),
        [
            account,
            loggedInAccounts,
            loggedInUserIds,
            visibleItems,
            workContexts,
            people,
            visibleRoutines,
            isInitialLoading,
            refreshItems,
            refreshWorkContexts,
            refreshPeople,
            refreshRoutines,
            refreshAccounts,
            syncAndRefresh,
        ],
    );

    /**
     * Boot effect: loads cached GTD data from IDB, triggers a server sync when online,
     * and wires up real-time channels (SSE, Web Push, SW message listener).
     */
    useEffect(() => {
        // Prevents the .then() from opening SSE/push after the component has already unmounted
        // (e.g. React strict-mode double-mount, or fast navigation away during loadAll).
        let unmounted = false;
        navigator.serviceWorker?.addEventListener('message', onSwMessage);
        // Ensure SW messages are dispatched immediately rather than being buffered until
        // the page's load event. Without this, postMessage from the SW push handler can
        // be lost if it fires before the load event completes.
        navigator.serviceWorker?.startMessages();
        loadAll()
            .then(() => {
                if (unmounted) {
                    return;
                }
                if (navigator.onLine) {
                    getOrCreateDeviceId(db).then((deviceId) => {
                        if (unmounted) {
                            return;
                        }
                        // Open one SSE channel per logged-in account. The orchestrator inside
                        // loadAll has already populated `loggedInUserIdsRef`, so reading it here
                        // covers every signed-in session — single-account devices still get one channel.
                        openSseConnections(onSseUpdateForUser, deviceId, loggedInUserIdsRef.current);
                    });
                    registerPushSubscriptionIfPermitted(db).catch((err) => console.error('[push] registration failed:', err));
                }
            })
            .catch((err) => console.error('[boot] load failed:', err));
        return () => {
            unmounted = true; // guards the .then() callback below (local scope)
            unmountedRef.current = true; // guards setState inside syncAndRefresh / initializeFromCache (shared scope)
            isFirstOnlineRender.current = true; // reset so the isOnline effect skips correctly on Strict Mode remount
            closeSseConnections();
            navigator.serviceWorker?.removeEventListener('message', onSwMessage);
        };
    }, [loadAll, onSwMessage, db, onSseUpdateForUser]);

    /**
     * Online/offline effect: when the device comes back online, flushes the sync queue,
     * re-establishes SSE, and re-registers push. Tears down SSE when going offline.
     * Skips the initial render — mount-time handling is already done in loadAll().
     */
    useEffect(() => {
        // Skip the initial render — mount-time online/offline handling is done in loadAll()
        if (isFirstOnlineRender.current) {
            isFirstOnlineRender.current = false;
            return;
        }
        if (isOnline) {
            // Flush unconditionally — isSyncingRef may block syncAndRefresh if an SSE-triggered
            // sync was in flight when the device went offline; a blocked syncAndRefresh would
            // silently drop the flush and leave queued ops stranded. flushSyncQueue has its own
            // concurrency guard (flushInFlight) so calling it here alongside syncAndRefresh is safe.
            flushSyncQueue(db).catch((err) => console.error('[online] flush failed:', err));
            syncAndRefresh().catch((err) => console.error('[online] sync failed:', err));
            getOrCreateDeviceId(db).then((deviceId) => {
                openSseConnections(onSseUpdateForUser, deviceId, loggedInUserIdsRef.current);
            });
            // Re-register push in case the subscription was lost or expired while offline.
            registerPushSubscriptionIfPermitted(db).catch((err) => console.error('[push] registration failed:', err));
        } else {
            // Close every SSE channel; they'll be re-opened when online fires
            closeSseConnections();
        }
        // No cleanup: the boot effect's cleanup already resets isFirstOnlineRender on unmount
        // for Strict Mode remounts. If this effect returned a cleanup that also reset it, the
        // offline→online transition would set the flag back to true (via the offline run's
        // cleanup), making the online run skip entirely — silently dropping the reconnect flush.
    }, [isOnline, db, syncAndRefresh, onSseUpdateForUser]);

    // AppResourceProvider is a no-op for current consumers — they still read entity arrays from the
    // legacy `appData` context above. Step 3 will switch consumers to `useAppResource()` and remove
    // the duplicate IDB reads. Mounting it here now keeps the resource snapshot in sync with the
    // active userIds set so the cutover is one-step.
    return (
        <AppDataContext.Provider value={appData}>
            <AppResourceProvider db={db} userIds={loggedInUserIds}>
                {children}
            </AppResourceProvider>
        </AppDataContext.Provider>
    );
}
