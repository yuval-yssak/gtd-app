import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { createFileRoute } from '@tanstack/react-router';
import type { IDBPDatabase } from 'idb';
import { useState } from 'react';
import { useAppData } from '../../contexts/AppDataContext';
import { requestAndRegisterPushSubscription } from '../../db/pushSubscription';
import type { MyDB } from '../../types/MyDB';

export const Route = createFileRoute('/_authenticated/settings')({
    component: SettingsPage,
});

function SettingsPage() {
    const { db } = Route.useRouteContext();
    const { account } = useAppData();

    return (
        <Box sx={{ maxWidth: 560 }}>
            <Typography variant="h5" fontWeight={600} mb={3}>
                Settings
            </Typography>

            {/* Account section */}
            <Paper variant="outlined" sx={{ mb: 3 }}>
                <Box sx={{ px: 2.5, py: 2 }}>
                    <Typography variant="subtitle1" fontWeight={600} mb={0.5}>
                        Account
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                        {account?.name ?? '—'} · {account?.email ?? '—'}
                    </Typography>
                </Box>
            </Paper>

            {/* Calendar sync section */}
            <Paper variant="outlined" sx={{ mb: 3 }}>
                <Box sx={{ px: 2.5, py: 2 }}>
                    <Typography variant="subtitle1" fontWeight={600} mb={0.5}>
                        Calendar Sync
                    </Typography>
                    <Typography variant="body2" color="text.secondary" mb={2}>
                        Connect a Google Calendar account to sync calendar items bidirectionally. Changes made here or in Google Calendar stay in sync
                        automatically.
                    </Typography>
                    <Divider sx={{ my: 1.5 }} />
                    <Typography variant="body2" color="text.secondary" fontStyle="italic" mb={2}>
                        No calendars connected.
                    </Typography>
                    <Button variant="outlined" size="small" disabled>
                        Connect Google Calendar (coming soon)
                    </Button>
                </Box>
            </Paper>

            {/* Notifications section */}
            <NotificationsSection db={db} />

            {/* App info */}
            <Paper variant="outlined">
                <Box sx={{ px: 2.5, py: 2 }}>
                    <Typography variant="subtitle1" fontWeight={600} mb={0.5}>
                        App
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                        Getting Things Done — offline-first GTD productivity app.
                    </Typography>
                </Box>
            </Paper>
        </Box>
    );
}

function NotificationsSection({ db }: { db: IDBPDatabase<MyDB> }) {
    // Inline capability check — avoids exporting a private helper from pushSubscription.ts.
    const isSupported = typeof Notification !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;

    const [permission, setPermission] = useState<NotificationPermission>(() => (isSupported ? Notification.permission : 'denied'));
    const [isRequesting, setIsRequesting] = useState(false);

    async function onEnable() {
        setIsRequesting(true);
        try {
            await requestAndRegisterPushSubscription(db);
        } finally {
            // Re-read from the browser — it's authoritative regardless of whether the call succeeded.
            setPermission(Notification.permission);
            setIsRequesting(false);
        }
    }

    return (
        <Paper variant="outlined" sx={{ mb: 3 }}>
            <Box sx={{ px: 2.5, py: 2 }}>
                <Typography variant="subtitle1" fontWeight={600} mb={0.5}>
                    Notifications
                </Typography>
                <Typography variant="body2" color="text.secondary" mb={2}>
                    Push notifications keep your items in sync across devices, even when the app is closed.
                </Typography>
                {!isSupported && (
                    <Typography variant="body2" color="text.secondary" fontStyle="italic">
                        Push notifications are not supported in this browser.
                    </Typography>
                )}
                {isSupported && permission === 'granted' && (
                    <Typography variant="body2" color="success.main">
                        Notifications enabled.
                    </Typography>
                )}
                {isSupported && permission === 'denied' && (
                    <Typography variant="body2" color="text.secondary" fontStyle="italic">
                        Notifications are blocked. To enable them, update your browser's site permissions.
                    </Typography>
                )}
                {isSupported && permission === 'default' && (
                    <Button variant="outlined" size="small" onClick={onEnable} disabled={isRequesting}>
                        {isRequesting ? 'Requesting…' : 'Enable notifications'}
                    </Button>
                )}
            </Box>
        </Paper>
    );
}
