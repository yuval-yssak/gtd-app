import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import Paper from '@mui/material/Paper';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Typography from '@mui/material/Typography';
import { createFileRoute } from '@tanstack/react-router';
import type { IDBPDatabase } from 'idb';
import { useState } from 'react';
import { useAppData } from '../../contexts/AppDataContext';
import { requestAndRegisterPushSubscription } from '../../db/pushSubscription';
import type { MyDB } from '../../types/MyDB';

type InlineClarifyMode = 'dialog' | 'expand' | 'popover' | 'instant';

const CLARIFY_MODE_KEY = 'gtd:inlineClarifyMode';

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

            {/* Inbox preferences */}
            <InboxSection />

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

function InboxSection() {
    const [mode, setMode] = useState<InlineClarifyMode>(() => (localStorage.getItem(CLARIFY_MODE_KEY) as InlineClarifyMode) ?? 'dialog');

    function onChange(newMode: InlineClarifyMode) {
        setMode(newMode);
        localStorage.setItem(CLARIFY_MODE_KEY, newMode);
        // storage event only fires in OTHER tabs by default — dispatch manually so the
        // inbox page updates in real time without requiring a reload.
        window.dispatchEvent(new StorageEvent('storage', { key: CLARIFY_MODE_KEY, newValue: newMode }));
    }

    return (
        <Paper variant="outlined" sx={{ mb: 3 }}>
            <Box sx={{ px: 2.5, py: 2 }}>
                <Typography variant="subtitle1" fontWeight={600} mb={0.5}>
                    Inbox
                </Typography>
                <Typography variant="body2" color="text.secondary" mb={2}>
                    How extra fields appear when you tap Next Action, Calendar, or Waiting For on an inbox item.
                </Typography>
                <RadioGroup value={mode} onChange={(e) => onChange(e.target.value as InlineClarifyMode)}>
                    <FormControlLabel
                        value="dialog"
                        control={<Radio size="small" />}
                        label={
                            <Box>
                                <Typography variant="body2">Dialog</Typography>
                                <Typography variant="caption" color="text.secondary">
                                    A focused dialog window
                                </Typography>
                            </Box>
                        }
                    />
                    <FormControlLabel
                        value="expand"
                        control={<Radio size="small" />}
                        label={
                            <Box>
                                <Typography variant="body2">Expand inline</Typography>
                                <Typography variant="caption" color="text.secondary">
                                    The item row expands in place
                                </Typography>
                            </Box>
                        }
                    />
                    <FormControlLabel
                        value="popover"
                        control={<Radio size="small" />}
                        label={
                            <Box>
                                <Typography variant="body2">Popover</Typography>
                                <Typography variant="caption" color="text.secondary">
                                    A floating panel near the button
                                </Typography>
                            </Box>
                        }
                    />
                    <FormControlLabel
                        value="instant"
                        control={<Radio size="small" />}
                        label={
                            <Box>
                                <Typography variant="body2">Instant</Typography>
                                <Typography variant="caption" color="text.secondary">
                                    Moves immediately with no extra fields (Next Action only; Calendar and Waiting For always show a form)
                                </Typography>
                            </Box>
                        }
                    />
                </RadioGroup>
            </Box>
        </Paper>
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
