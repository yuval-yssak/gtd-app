import type { IDBPDatabase } from 'idb';
import { createContext, type PropsWithChildren, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getActiveAccount } from '../db/accountHelpers';
import { getItemsByUser } from '../db/itemHelpers';
import { getPeopleByUser } from '../db/personHelpers';
import { registerPushSubscriptionIfPermitted } from '../db/pushSubscription';
import { closeSseConnection, openSseConnection } from '../db/sseClient';
import { bootstrapFromServer, flushSyncQueue, pullFromServer } from '../db/syncHelpers';
import { getWorkContextsByUser } from '../db/workContextHelpers';
import { useOnline } from '../hooks/useOnline';
import type { MyDB, StoredAccount, StoredItem, StoredPerson, StoredWorkContext } from '../types/MyDB';

export interface AppData {
    account: StoredAccount | null;
    items: StoredItem[];
    workContexts: StoredWorkContext[];
    people: StoredPerson[];
    refreshItems: () => Promise<void>;
    refreshWorkContexts: () => Promise<void>;
    refreshPeople: () => Promise<void>;
}

// biome-ignore lint/style/noNonNullAssertion: Context is initialized with a non-null default value and only used within the provider, so this is safe.
const AppDataContext = createContext<AppData>(undefined!);

export function useAppData(): AppData {
    return useContext(AppDataContext);
}

async function syncFromServerWithBootstrapFallback(db: IDBPDatabase<MyDB>) {
    // Bootstrap instead of pull when the device has never synced — historical ops may
    // have been purged before this device registered, so pull-from-epoch would miss data.
    const syncState = await db.get('deviceSyncState', 'local');
    if (!syncState) {
        await bootstrapFromServer(db);
        return;
    }
    await pullFromServer(db);
}

export function AppDataProvider({ db, children }: PropsWithChildren<{ db: IDBPDatabase<MyDB> }>) {
    const [account, setAccount] = useState<StoredAccount | null>(null);
    const [items, setItems] = useState<StoredItem[]>([]);
    const [workContexts, setWorkContexts] = useState<StoredWorkContext[]>([]);
    const [people, setPeople] = useState<StoredPerson[]>([]);
    const isOnline = useOnline();
    const isFirstOnlineRender = useRef(true); // Skips the first render of the isOnline effect — mount-time handling is done in loadAll()

    const refreshItems = useCallback(async () => {
        const acct = await getActiveAccount(db);
        if (!acct) return;
        setItems(await getItemsByUser(db, acct.id));
    }, [db]);
    const refreshWorkContexts = useCallback(async () => {
        const acct = await getActiveAccount(db);
        if (!acct) return;
        setWorkContexts(await getWorkContextsByUser(db, acct.id));
    }, [db]);
    const refreshPeople = useCallback(async () => {
        const acct = await getActiveAccount(db);
        if (!acct) return;
        setPeople(await getPeopleByUser(db, acct.id));
    }, [db]);

    // Guards against concurrent invocations from three independent paths: boot effect,
    // SSE callback, and SW push message. flushSyncQueue/pullFromServer have their own
    // module-level guards, but this prevents redundant IDB reads and setState batches.
    const isSyncingRef = useRef(false);
    // Prevents setState calls from in-flight syncAndRefresh/initializeFromCache after unmount
    // (e.g. React Strict Mode double-mount, or fast navigation away during a network round-trip).
    const unmountedRef = useRef(false);

    // Extracted so both the mount effect and the isOnline effect can call it.
    const syncAndRefresh = useCallback(async () => {
        if (isSyncingRef.current) {
            return;
        }
        isSyncingRef.current = true;
        try {
            const acct = await getActiveAccount(db);
            if (!acct) {
                return;
            }

            await flushSyncQueue(db);
            await syncFromServerWithBootstrapFallback(db);

            // Guard after the async work — component may have unmounted while awaiting network.
            if (unmountedRef.current) {
                return;
            }
            setItems(await getItemsByUser(db, acct.id));
            setWorkContexts(await getWorkContextsByUser(db, acct.id));
            setPeople(await getPeopleByUser(db, acct.id));
        } finally {
            isSyncingRef.current = false;
        }
    }, [db]);

    const initializeFromCache = useCallback(
        async (acct: StoredAccount) => {
            // Show cached data immediately — works offline with no network round-trip
            const [items, workContexts, people] = await Promise.all([
                getItemsByUser(db, acct.id),
                getWorkContextsByUser(db, acct.id),
                getPeopleByUser(db, acct.id),
            ]);
            // Skip setState if the component unmounted while the IDB reads were in flight.
            if (unmountedRef.current) {
                return;
            }
            setAccount(acct);
            setItems(items);
            setWorkContexts(workContexts);
            setPeople(people);
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
            return;
        }
        await initializeFromCache(acct);
        if (!navigator.onLine) {
            return;
        }
        await syncAndRefresh();
    }, [db, initializeFromCache, syncAndRefresh]);

    const appData: AppData = useMemo(
        () => ({ account, items, workContexts, people, refreshItems, refreshWorkContexts, refreshPeople }),
        [account, items, workContexts, people, refreshItems, refreshWorkContexts, refreshPeople],
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
        loadAll()
            .then(() => {
                if (unmounted) {
                    return;
                }
                if (navigator.onLine) {
                    openSseConnection(() => syncAndRefresh().catch((err) => console.error('[sse] sync failed:', err)));
                    registerPushSubscriptionIfPermitted(db).catch((err) => console.error('[push] registration failed:', err));
                }
            })
            .catch((err) => console.error('[boot] load failed:', err));
        return () => {
            unmounted = true; // guards the .then() callback below (local scope)
            unmountedRef.current = true; // guards setState inside syncAndRefresh / initializeFromCache (shared scope)
            isFirstOnlineRender.current = true; // reset so the isOnline effect skips correctly on Strict Mode remount
            closeSseConnection();
            navigator.serviceWorker?.removeEventListener('message', onSwMessage);
        };
    }, [loadAll, onSwMessage, db, syncAndRefresh]);

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
            syncAndRefresh().catch((err) => console.error('[online] sync failed:', err));
            openSseConnection(() => syncAndRefresh().catch((err) => console.error('[sse] sync failed:', err)));
            // Re-register push in case the subscription was lost or expired while offline.
            registerPushSubscriptionIfPermitted(db).catch((err) => console.error('[push] registration failed:', err));
        } else {
            // Close the SSE connection; it will be re-opened when online fires
            closeSseConnection();
        }
        return () => {
            isFirstOnlineRender.current = true; // reset so the boot effect skips correctly on Strict Mode remount
        };
    }, [isOnline, db, syncAndRefresh]);

    return <AppDataContext.Provider value={appData}>{children}</AppDataContext.Provider>;
}
