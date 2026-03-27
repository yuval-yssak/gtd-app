import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { useEffect } from 'react';
import { AccountSwitcher } from '../components/AccountSwitcher';
import { StatusBar } from '../components/StatusBar';
import { getActiveAccount } from '../db/accountHelpers';
import { getItemsByUser } from '../db/itemHelpers';
import { registerPushSubscription } from '../db/pushSubscription';
import { closeSseConnection, openSseConnection } from '../db/sseClient';
import { flushSyncQueue, pullFromServer } from '../db/syncHelpers';
import { authClient } from '../lib/authClient';

export const Route = createFileRoute('/_authenticated')({
    beforeLoad: async ({ context }) => {
        const { db } = context;

        let session = null;
        let networkError = false;

        try {
            const result = await authClient.getSession();
            session = result.data;
        } catch {
            // fetch threw — server is unreachable (offline or DNS failure)
            networkError = true;
        }

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
    const { db, setItems } = Route.useRouteContext();

    useEffect(() => {
        let cancelled = false;

        async function syncAndRefresh() {
            const account = await getActiveAccount(db);
            if (!account || cancelled) return;

            await flushSyncQueue(db);
            await pullFromServer(db);
            if (cancelled) return;

            const refreshed = await getItemsByUser(db, account.id);
            if (!cancelled) setItems(refreshed);
        }

        async function loadItems() {
            const account = await getActiveAccount(db);
            if (!account || cancelled) return;

            // Show cached items immediately — works offline with no network round-trip
            const local = await getItemsByUser(db, account.id);
            if (!cancelled) setItems(local);

            if (!navigator.onLine) return;

            await syncAndRefresh();

            // Open SSE so this tab receives real-time pushes from other devices
            openSseConnection(() => { syncAndRefresh().catch(() => {}); });

            // Register Web Push subscription so the SW can pull while the app is closed
            registerPushSubscription(db).catch(() => {});
        }

        async function handleOnline() {
            if (cancelled) return;
            await syncAndRefresh();
            openSseConnection(() => { syncAndRefresh().catch(() => {}); });
        }

        function handleOffline() {
            // Close the SSE connection; it will be re-opened when online fires
            closeSseConnection();
        }

        loadItems();
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        return () => {
            cancelled = true;
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
            closeSseConnection();
        };
    }, [db, setItems]);

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
            <AppBar position="static">
                <Toolbar>
                    <Typography variant="h6" sx={{ flexGrow: 1 }}>
                        GTD
                    </Typography>
                    <AccountSwitcher db={db} />
                </Toolbar>
            </AppBar>
            <Box component="main" sx={{ flexGrow: 1, p: 3 }}>
                <Outlet />
            </Box>
            <StatusBar />
        </Box>
    );
}
