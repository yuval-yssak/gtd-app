import CloseIcon from '@mui/icons-material/Close';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import type { IDBPDatabase } from 'idb';
import { useState } from 'react';
import { requestAndRegisterPushSubscription } from '../db/pushSubscription';
import type { MyDB } from '../types/MyDB';

const DISMISSED_KEY = 'gtd:notifNudgeDismissed';

interface Props {
    db: IDBPDatabase<MyDB>;
}

export function NotificationNudge({ db }: Props) {
    // Guard: browsers without Notification/SW/PushManager support should never see this nudge.
    const isSupported = typeof Notification !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;

    const [permission, setPermission] = useState<NotificationPermission>(() => (isSupported ? Notification.permission : 'denied'));
    const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY) === 'true');

    // Only show when the user hasn't decided yet and hasn't explicitly dismissed the nudge.
    if (!isSupported || permission !== 'default' || dismissed) return null;

    async function onEnable() {
        const granted = await requestAndRegisterPushSubscription(db);
        // Re-read the live permission rather than inferring from the return value —
        // the browser is authoritative and may have changed it to 'denied' or 'default'.
        setPermission(granted ? 'granted' : Notification.permission);
    }

    function onDismiss() {
        localStorage.setItem(DISMISSED_KEY, 'true');
        setDismissed(true);
    }

    return (
        <Alert
            severity="info"
            sx={{ mt: 2 }}
            // MUI Alert: providing `action` suppresses the built-in close button,
            // so we include our own dismiss icon alongside the Enable CTA.
            action={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <Button color="inherit" size="small" onClick={onEnable}>
                        Enable
                    </Button>
                    <IconButton color="inherit" size="small" aria-label="dismiss" onClick={onDismiss}>
                        <CloseIcon fontSize="small" />
                    </IconButton>
                </Box>
            }
        >
            Enable push notifications to stay in sync across devices, even when the app is closed.
        </Alert>
    );
}
