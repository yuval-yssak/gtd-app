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
    const { db, setItems } = Route.useRouteContext();
    const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

    useEffect(() => {
        // No cancellation flag needed: event listeners are removed on cleanup so they
        // cannot fire after unmount, and React 19 silently ignores setState on unmounted components.
        async function syncAndRefresh() {
            const account = await getActiveAccount(db);
            if (!account) {
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

            setItems(await getItemsByUser(db, account.id));
        }

        async function loadItems() {
            const account = await getActiveAccount(db);
            if (!account) {
                return;
            }

            // Show cached items immediately — works offline with no network round-trip
            setItems(await getItemsByUser(db, account.id));

            if (!navigator.onLine) {
                return;
            }

            await syncAndRefresh();

            // Open SSE so this tab receives real-time pushes from other devices
            openSseConnection(() => {
                syncAndRefresh().catch(() => {});
            });

            // Register Web Push subscription so the SW can pull while the app is closed
            registerPushSubscription(db).catch(() => {});
        }

        async function handleOnline() {
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
