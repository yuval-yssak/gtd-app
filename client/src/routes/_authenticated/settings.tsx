import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import { useColorScheme } from '@mui/material/styles';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { createFileRoute } from '@tanstack/react-router';
import type { IDBPDatabase } from 'idb';
import { useState } from 'react';
import { CalendarIntegrations } from '../../components/settings/CalendarIntegrations';
import { useAppData } from '../../contexts/AppDataProvider';
import { requestAndRegisterPushSubscription } from '../../db/pushSubscription';
import { getCalendarHorizonMonths, setCalendarHorizonMonths } from '../../lib/calendarHorizon';
import { CLARIFY_MODE_KEY, type InlineClarifyMode, parseClarifyMode } from '../../lib/clarifyMode';
import { getRoutineIndicatorStyle, type RoutineIndicatorStyle, setRoutineIndicatorStyle } from '../../lib/routineIndicatorStyle';
import type { MyDB } from '../../types/MyDB';
import styles from './-settings.module.css';

export const Route = createFileRoute('/_authenticated/settings')({
    validateSearch: (search) => {
        const { calendarConnected: raw } = search;
        return { calendarConnected: typeof raw === 'string' ? raw : undefined };
    },
    component: SettingsPage,
});

function SettingsPage() {
    const { db } = Route.useRouteContext();
    const { account } = useAppData();

    return (
        <Box className={styles.pageWrapper}>
            <Typography variant="h5" fontWeight={600} mb={3}>
                Settings
            </Typography>

            {/* Account section */}
            <Paper variant="outlined" className={styles.section}>
                <Box className={styles.sectionContent}>
                    <Typography variant="subtitle1" fontWeight={600} mb={0.5}>
                        Account
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                        {account?.name ?? '—'} · {account?.email ?? '—'}
                    </Typography>
                </Box>
            </Paper>

            {/* Appearance section */}
            <AppearanceSection />

            {/* Calendar sync section */}
            <Paper variant="outlined" className={styles.section}>
                <Box className={styles.sectionContent}>
                    <Typography variant="subtitle1" fontWeight={600} mb={0.5}>
                        Calendar Sync
                    </Typography>
                    <Typography variant="body2" color="text.secondary" mb={2}>
                        Connect a Google Calendar account to sync calendar items bidirectionally. Changes made here or in Google Calendar stay in sync
                        automatically.
                    </Typography>
                    <Divider className={styles.divider} />
                    <CalendarIntegrations />
                </Box>
            </Paper>

            {/* Calendar horizon */}
            <CalendarHorizonSection />

            {/* Routine indicator style */}
            <RoutineIndicatorSection />

            {/* Inbox preferences */}
            <InboxSection />

            {/* Notifications section */}
            <NotificationsSection db={db} />

            {/* App info */}
            <Paper variant="outlined">
                <Box className={styles.sectionContent}>
                    <Typography variant="subtitle1" fontWeight={600} mb={0.5}>
                        App
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                        Getting Things Done — offline-first GTD productivity app.
                    </Typography>
                    <Typography variant="caption" color="text.secondary" mt={1} component="p">
                        Version: {__COMMIT_HASH__}
                    </Typography>
                </Box>
            </Paper>
        </Box>
    );
}

function AppearanceSection() {
    const { mode, setMode } = useColorScheme();

    return (
        <Paper variant="outlined" className={styles.section}>
            <Box className={styles.sectionContent}>
                <Typography variant="subtitle1" fontWeight={600} mb={0.5}>
                    Appearance
                </Typography>
                <RadioGroup value={mode ?? 'system'} onChange={(e) => setMode(e.target.value as 'light' | 'dark' | 'system')}>
                    <FormControlLabel value="light" control={<Radio size="small" />} label={<Typography variant="body2">Light</Typography>} />
                    <FormControlLabel
                        value="system"
                        control={<Radio size="small" />}
                        label={
                            <Box>
                                <Typography variant="body2">System</Typography>
                                <Typography variant="caption" color="text.secondary">
                                    Follows your OS setting
                                </Typography>
                            </Box>
                        }
                    />
                    <FormControlLabel value="dark" control={<Radio size="small" />} label={<Typography variant="body2">Dark</Typography>} />
                </RadioGroup>
            </Box>
        </Paper>
    );
}

const HORIZON_OPTIONS = [1, 2, 3, 4, 6, 9, 12] as const;

function CalendarHorizonSection() {
    const [horizon, setHorizon] = useState(() => getCalendarHorizonMonths());

    function onChange(months: number) {
        setHorizon(months);
        setCalendarHorizonMonths(months);
    }

    return (
        <Paper variant="outlined" className={styles.section}>
            <Box className={styles.sectionContent}>
                <Typography variant="subtitle1" fontWeight={600} mb={0.5}>
                    Calendar horizon
                </Typography>
                <Typography variant="body2" color="text.secondary" mb={2}>
                    How far ahead to generate calendar items for recurring routines. Existing routines are not affected until their next edit or item
                    completion.
                </Typography>
                <TextField select size="small" value={horizon} onChange={(e) => onChange(Number(e.target.value))} sx={{ width: 160 }}>
                    {HORIZON_OPTIONS.map((m) => (
                        <MenuItem key={m} value={m}>
                            {m === 1 ? '1 month' : `${m} months`}
                        </MenuItem>
                    ))}
                </TextField>
            </Box>
        </Paper>
    );
}

function InboxSection() {
    const [clarifyMode, setClarifyMode] = useState<InlineClarifyMode>(() => parseClarifyMode(localStorage.getItem(CLARIFY_MODE_KEY)));

    function onChange(newMode: InlineClarifyMode) {
        setClarifyMode(newMode);
        localStorage.setItem(CLARIFY_MODE_KEY, newMode);
        // storage event only fires in OTHER tabs by default — dispatch manually so the
        // inbox page updates in real time without requiring a reload.
        window.dispatchEvent(new StorageEvent('storage', { key: CLARIFY_MODE_KEY, newValue: newMode }));
    }

    return (
        <Paper variant="outlined" className={styles.section}>
            <Box className={styles.sectionContent}>
                <Typography variant="subtitle1" fontWeight={600} mb={0.5}>
                    Inbox
                </Typography>
                <Typography variant="body2" color="text.secondary" mb={2}>
                    How you prefer to edit and clarify items — applies to the inbox and all other pages.
                </Typography>
                <RadioGroup value={clarifyMode} onChange={(e) => onChange(parseClarifyMode(e.target.value))}>
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
                    <FormControlLabel
                        value="page"
                        control={<Radio size="small" />}
                        label={
                            <Box>
                                <Typography variant="body2">Full Page</Typography>
                                <Typography variant="caption" color="text.secondary">
                                    Opens a dedicated page for clarifying the item
                                </Typography>
                            </Box>
                        }
                    />
                </RadioGroup>
            </Box>
        </Paper>
    );
}

function RoutineIndicatorSection() {
    const [style, setStyle] = useState<RoutineIndicatorStyle>(() => getRoutineIndicatorStyle());

    function onChange(newStyle: RoutineIndicatorStyle) {
        setStyle(newStyle);
        setRoutineIndicatorStyle(newStyle);
    }

    return (
        <Paper variant="outlined" className={styles.section}>
            <Box className={styles.sectionContent}>
                <Typography variant="subtitle1" fontWeight={600} mb={0.5}>
                    Routine indicator
                </Typography>
                <Typography variant="body2" color="text.secondary" mb={1}>
                    How items linked to a routine are marked in lists.
                </Typography>
                <RadioGroup value={style} onChange={(e) => onChange(e.target.value as RoutineIndicatorStyle)}>
                    <FormControlLabel value="icon" control={<Radio size="small" />} label={<Typography variant="body2">Loop icon</Typography>} />
                    <FormControlLabel value="colorAccent" control={<Radio size="small" />} label={<Typography variant="body2">Color dot</Typography>} />
                    <FormControlLabel value="chip" control={<Radio size="small" />} label={<Typography variant="body2">Chip label</Typography>} />
                    <FormControlLabel value="none" control={<Radio size="small" />} label={<Typography variant="body2">None</Typography>} />
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
        <Paper variant="outlined" className={styles.section}>
            <Box className={styles.sectionContent}>
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
