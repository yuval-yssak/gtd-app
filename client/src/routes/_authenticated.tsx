import MenuIcon from '@mui/icons-material/Menu';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import type { IDBPDatabase } from 'idb';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AccountSwitcher } from '../components/AccountSwitcher';
import { AppNav, DRAWER_WIDTH } from '../components/AppNav';
import { NotificationNudge } from '../components/NotificationNudge';
import { type AppData, AppDataContext } from '../contexts/AppDataContext';
import { getActiveAccount } from '../db/accountHelpers';
import { getItemsByUser } from '../db/itemHelpers';
import { getPeopleByUser } from '../db/personHelpers';
import { registerPushSubscriptionIfPermitted } from '../db/pushSubscription';
import { closeSseConnection, openSseConnection } from '../db/sseClient';
import { bootstrapFromServer, flushSyncQueue, pullFromServer } from '../db/syncHelpers';
import { getWorkContextsByUser } from '../db/workContextHelpers';
import { authClient } from '../lib/authClient';
import type { MyDB, StoredAccount, StoredItem, StoredPerson, StoredWorkContext } from '../types/MyDB';

// Wraps authClient.getSession() to distinguish a missing session from a network failure.
// Returns networkError=true when the fetch throws (offline/DNS), false when the server responded.
async function fetchSessionSafely() {
    try {
        const result = await authClient.getSession();
        return { session: result.data, networkError: false };
    } catch {
        return { session: null, networkError: true };
    }
}

// Shared implementation for all three entity refresh functions — re-fetches the active
// account and reloads the entity list into React state. Called inside useCallback so
// db appears explicitly in each callback body (required for Biome's deps exhaustiveness check).
async function refreshEntityList<T>(
    db: IDBPDatabase<MyDB>,
    getter: (db: IDBPDatabase<MyDB>, userId: string) => Promise<T[]>,
    setter: React.Dispatch<React.SetStateAction<T[]>>,
): Promise<void> {
    const acct = await getActiveAccount(db);
    if (!acct) {
        return;
    }
    setter(await getter(db, acct.id));
}

export const Route = createFileRoute('/_authenticated')({
    beforeLoad: async ({ context }) => {
        const { db } = context;
        const { session, networkError } = await fetchSessionSafely();

        if (!networkError && !session) {
            // Server responded but session is gone — must re-authenticate
            throw redirect({ to: '/login' });
        }

        if (networkError) {
            // Offline: allow through only if this device has a cached account,
            // meaning the user previously authenticated on this device.
            const activeAccount = await getActiveAccount(db);
            if (!activeAccount) {
                throw redirect({ to: '/login' });
            }
            return { session: null };
        }

        return { session };
    },
    component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
    const { db } = Route.useRouteContext();
    const [isMobileDrawerOpen, setIsMobileDrawerOpen] = useState(false);
    const [account, setAccount] = useState<StoredAccount | null>(null);
    const [items, setItems] = useState<StoredItem[]>([]);
    const [workContexts, setWorkContexts] = useState<StoredWorkContext[]>([]);
    const [people, setPeople] = useState<StoredPerson[]>([]);

    // Refresh functions re-fetch account each call so they remain stable (only depend on db).
    const refreshItems = useCallback(() => refreshEntityList(db, getItemsByUser, setItems), [db]);
    const refreshWorkContexts = useCallback(() => refreshEntityList(db, getWorkContextsByUser, setWorkContexts), [db]);
    const refreshPeople = useCallback(() => refreshEntityList(db, getPeopleByUser, setPeople), [db]);

    const appData: AppData = useMemo(
        () => ({ account, items, workContexts, people, refreshItems, refreshWorkContexts, refreshPeople }),
        [account, items, workContexts, people, refreshItems, refreshWorkContexts, refreshPeople],
    );

    useEffect(() => {
        // No cancellation flag needed: event listeners are removed on cleanup so they
        // cannot fire after unmount, and React 19 silently ignores setState on unmounted components.
        async function syncAndRefresh() {
            const acct = await getActiveAccount(db);
            if (!acct) {
                return;
            }

            await flushSyncQueue(db);

            // Bootstrap instead of pull when the device has never synced — historical ops may
            // have been purged before this device registered, so pull-from-epoch would miss data.
            const syncState = await db.get('deviceSyncState', 'local');
            if (!syncState) {
                await bootstrapFromServer(db);
            } else {
                await pullFromServer(db);
            }

            setItems(await getItemsByUser(db, acct.id));
        }

        async function initializeFromCache(acct: StoredAccount) {
            setAccount(acct);
            // Show cached data immediately — works offline with no network round-trip
            setItems(await getItemsByUser(db, acct.id));
            setWorkContexts(await getWorkContextsByUser(db, acct.id));
            setPeople(await getPeopleByUser(db, acct.id));
        }

        function connectToRealtime(onUpdate: () => void) {
            // Open SSE so this tab receives real-time pushes from other devices
            openSseConnection(onUpdate);
            // Register Web Push subscription so the SW can pull while the app is closed
            registerPushSubscriptionIfPermitted(db).catch((err) => console.error('[push] registration failed:', err));
        }

        async function loadAll() {
            const acct = await getActiveAccount(db);
            if (!acct) {
                return;
            }
            await initializeFromCache(acct);
            if (!navigator.onLine) {
                return;
            }
            await syncAndRefresh();
            connectToRealtime(() => syncAndRefresh().catch((err) => console.error('[sse] sync failed:', err)));
        }

        async function onNetworkOnline() {
            await syncAndRefresh();
            openSseConnection(() => syncAndRefresh().catch((err) => console.error('[sse] sync failed:', err)));
            // Re-register push in case the subscription was lost or expired while offline.
            registerPushSubscriptionIfPermitted(db).catch((err) => console.error('[push] registration failed:', err));
        }

        function onNetworkOffline() {
            // Close the SSE connection; it will be re-opened when online fires
            closeSseConnection();
        }

        loadAll();
        window.addEventListener('online', onNetworkOnline);
        window.addEventListener('offline', onNetworkOffline);
        return () => {
            window.removeEventListener('online', onNetworkOnline);
            window.removeEventListener('offline', onNetworkOffline);
            closeSseConnection();
        };
    }, [db]);

    return (
        <Box sx={{ display: 'flex', minHeight: '100vh' }}>
            {/* Mobile AppBar — fixed at top, hidden on desktop where the sidebar takes over */}
            <AppBar
                position="fixed"
                sx={{
                    display: { md: 'none' },
                    zIndex: (theme) => theme.zIndex.drawer + 1,
                }}
            >
                <Toolbar>
                    <IconButton color="inherit" edge="start" onClick={() => setIsMobileDrawerOpen(true)} sx={{ mr: 1 }} aria-label="open navigation">
                        <MenuIcon />
                    </IconButton>
                    <Typography variant="h6" sx={{ flexGrow: 1 }}>
                        GTD
                    </Typography>
                    <AccountSwitcher db={db} />
                </Toolbar>
            </AppBar>

            <AppNav isMobileDrawerOpen={isMobileDrawerOpen} setIsMobileDrawerOpen={setIsMobileDrawerOpen} db={db} />

            <Box
                component="main"
                sx={{
                    flexGrow: 1,
                    // Desktop: content sits to the right of the sidebar
                    ml: { md: `${DRAWER_WIDTH}px` },
                    width: { md: `calc(100% - ${DRAWER_WIDTH}px)` },
                    // Mobile: push content below the fixed AppBar and above the bottom nav
                    pt: { xs: 9, md: 3 },
                    pb: { xs: 9, md: 3 },
                    px: { xs: 2, md: 3 },
                    overflow: 'auto',
                }}
            >
                <AppDataContext.Provider value={appData}>
                    <Outlet />
                    <NotificationNudge db={db} />
                </AppDataContext.Provider>
            </Box>
        </Box>
    );
}
