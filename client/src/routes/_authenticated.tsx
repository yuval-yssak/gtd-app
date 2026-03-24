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
import { flushSyncQueue, seedItemsFromServer } from '../db/syncHelpers';
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

        async function loadItems() {
            const account = await getActiveAccount(db);
            if (!account || cancelled) return;

            // Show cached items immediately so the UI is useful offline
            const local = await getItemsByUser(db, account.id);
            if (!cancelled) setItems(local);

            if (navigator.onLine) {
                await seedItemsFromServer(db, account.id);
                if (cancelled) return;
                const refreshed = await getItemsByUser(db, account.id);
                if (!cancelled) setItems(refreshed);
            }
        }

        async function handleOnline() {
            const account = await getActiveAccount(db);
            if (!account || cancelled) return;
            // Flush queued mutations first so the seed reflects our offline changes
            await flushSyncQueue(db);
            await seedItemsFromServer(db, account.id);
            if (cancelled) return;
            const refreshed = await getItemsByUser(db, account.id);
            if (!cancelled) setItems(refreshed);
        }

        loadItems();
        window.addEventListener('online', handleOnline);
        return () => {
            // cancelled prevents stale async callbacks from calling setItems after unmount
            cancelled = true;
            window.removeEventListener('online', handleOnline);
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
