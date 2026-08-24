import MenuIcon from '@mui/icons-material/Menu';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { createFileRoute, Outlet } from '@tanstack/react-router';
import { Suspense, useState } from 'react';
import { AccountReauthDialog } from '../components/AccountReauthDialog';
import { AccountSwitcher } from '../components/AccountSwitcher';
import { AppErrorBoundary } from '../components/AppErrorBoundary';
import { AppNav } from '../components/AppNav';
import { NavigationProgress } from '../components/NavigationProgress';
import { NotificationNudge } from '../components/NotificationNudge';
import { QuickCaptureFab } from '../components/quickCapture/QuickCaptureFab';
import { RouteFallback } from '../components/RouteFallback';
import { SyncRecoveryDialog } from '../components/SyncRecoveryDialog';
import { UndoSnackbar } from '../components/UndoSnackbar';
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
            {/* Immediate feedback while a navigation's transition renders the destination page */}
            <NavigationProgress />
            {/* Blocking reaped-device recovery dialog — mounted ONCE at the layout root (unlike the
                reauth banner it must not double-mount with AppNav's drawers) and outside the route
                Suspense boundary so it stays visible while recovery swaps the data underneath. */}
            <SyncRecoveryDialog db={db} />
            {/* Blocking "account needs re-login" dialog — mounted ONCE here (its banner counterpart
                double-mounts inside AppNav's drawers; a modal must not). */}
            <AccountReauthDialog db={db} />
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
                                {/* Global "Saved — UNDO" surface for autosaving editors; fed by lib/undoStore. */}
                                <UndoSnackbar />
                            </Suspense>
                            {/* App-wide quick capture: FAB + the "c" shortcut on every page. Outside the
                                route Suspense so a route-level suspend can't unmount it mid-capture
                                (discarding typed text and the keydown listener); it reads useAppData(),
                                so it must stay inside AppDataProvider. */}
                            <QuickCaptureFab db={db} />
                        </AppErrorBoundary>
                    </AppDataProvider>
                </PendingReassignProvider>
            </Box>
        </Box>
    );
}
