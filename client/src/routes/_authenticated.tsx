import MenuIcon from '@mui/icons-material/Menu';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { createFileRoute, Outlet } from '@tanstack/react-router';
import { Suspense, useState } from 'react';
import { AccountSwitcher } from '../components/AccountSwitcher';
import { AppErrorBoundary } from '../components/AppErrorBoundary';
import { AppNav } from '../components/AppNav';
import { NotificationNudge } from '../components/NotificationNudge';
import { RouteFallback } from '../components/RouteFallback';
import { AppDataProvider } from '../contexts/AppDataProvider';
import { PendingReassignProvider } from '../contexts/PendingReassignProvider';
import styles from './-_authenticated.module.css';
import { authenticatedRouteGuard } from './-authenticatedRouteGuard';

export const Route = createFileRoute('/_authenticated')({
    beforeLoad: authenticatedRouteGuard,
    component: AuthenticatedLayout,
});

export function AuthenticatedLayout() {
    const { db } = Route.useRouteContext();
    const [isMobileDrawerOpen, setIsMobileDrawerOpen] = useState(false);

    return (
        <Box className={styles.appShell}>
            {/* Mobile AppBar — fixed at top, hidden on desktop where the sidebar takes over */}
            <AppBar position="fixed" className={styles.mobileAppBar}>
                <Toolbar>
                    <IconButton
                        color="inherit"
                        edge="start"
                        onClick={() => setIsMobileDrawerOpen(true)}
                        className={styles.menuButton}
                        aria-label="open navigation"
                    >
                        <MenuIcon />
                    </IconButton>
                    <Typography variant="h6" className={styles.appBarTitle}>
                        GTD
                    </Typography>
                    <AccountSwitcher db={db} />
                </Toolbar>
            </AppBar>

            <AppNav isMobileDrawerOpen={isMobileDrawerOpen} setIsMobileDrawerOpen={setIsMobileDrawerOpen} db={db} />

            <Box component="main" className={styles.mainContent}>
                <PendingReassignProvider db={db}>
                    <AppDataProvider db={db}>
                        {/* Inner boundary catches Suspense from `useAppData()`'s `use()` calls during the
                            initial IDB read. The boot path then renders RouteFallback in place of every
                            authenticated route until the per-user resource resolves. */}
                        <AppErrorBoundary mode="page">
                            <Suspense fallback={<RouteFallback />}>
                                <Outlet />
                                <NotificationNudge db={db} />
                            </Suspense>
                        </AppErrorBoundary>
                    </AppDataProvider>
                </PendingReassignProvider>
            </Box>
        </Box>
    );
}
