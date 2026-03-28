import MenuIcon from '@mui/icons-material/Menu';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { AccountSwitcher } from '../components/AccountSwitcher';
import { AppNav, DRAWER_WIDTH } from '../components/AppNav';
import { getActiveAccount } from '../db/accountHelpers';
import { getItemsByUser } from '../db/itemHelpers';
import { registerPushSubscription } from '../db/pushSubscription';
import { closeSseConnection, openSseConnection } from '../db/sseClient';
import { bootstrapFromServer, flushSyncQueue, pullFromServer } from '../db/syncHelpers';
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
    const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

    useEffect(() => {
        let cancelled = false;

        async function syncAndRefresh() {
            const account = await getActiveAccount(db);
            if (!account || cancelled) return;

            await flushSyncQueue(db);

            // Bootstrap instead of pull when the device has never synced — historical ops may
            // have been purged before this device registered, so pull-from-epoch would miss data.
            const syncState = await db.get('deviceSyncState', 'local');
            if (!syncState) {
                await bootstrapFromServer(db);
            } else {
                await pullFromServer(db);
            }

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
            openSseConnection(() => {
                syncAndRefresh().catch(() => {});
            });

            // Register Web Push subscription so the SW can pull while the app is closed
            registerPushSubscription(db).catch(() => {});
        }

        async function handleOnline() {
            if (cancelled) return;
            await syncAndRefresh();
            openSseConnection(() => {
                syncAndRefresh().catch(() => {});
            });
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
                    <IconButton color="inherit" edge="start" onClick={() => setMobileDrawerOpen(true)} sx={{ mr: 1 }} aria-label="open navigation">
                        <MenuIcon />
                    </IconButton>
                    <Typography variant="h6" sx={{ flexGrow: 1 }}>
                        GTD
                    </Typography>
                    <AccountSwitcher db={db} />
                </Toolbar>
            </AppBar>

            <AppNav mobileDrawerOpen={mobileDrawerOpen} setMobileDrawerOpen={setMobileDrawerOpen} db={db} />

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
                <Outlet />
            </Box>
        </Box>
    );
}
