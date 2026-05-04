import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
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
import classNames from 'classnames';
import type { IDBPDatabase } from 'idb';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { getPushStatus } from '../../api/pushApi';
import { CalendarIntegrations } from '../../components/settings/CalendarIntegrations';
import { useAppData } from '../../contexts/AppDataProvider';
import { getOrCreateDeviceId } from '../../db/deviceId';
import { requestAndRegisterPushSubscription } from '../../db/pushSubscription';
import { getCalendarHorizonMonths, setCalendarHorizonMonths } from '../../lib/calendarHorizon';
import { CLARIFY_MODE_KEY, type InlineClarifyMode, parseClarifyMode } from '../../lib/clarifyMode';
import { COLOR_THEMES, type ColorThemeId, getColorTheme, setColorTheme } from '../../lib/colorTheme';
import { getRoutineIndicatorStyle, type RoutineIndicatorStyle, setRoutineIndicatorStyle } from '../../lib/routineIndicatorStyle';
import type { MyDB } from '../../types/MyDB';
import styles from './-settings.module.css';

// Search schema is declared with both fields optional so navigate({ search: (prev) => ({ ...prev, calendarConnected: undefined }) })
// can clear one param without being forced to also re-supply the sibling.
interface SettingsSearch {
    calendarConnected?: string | undefined;
    /** Surfaces an inline error when the post-OAuth callback rejects a mismatched account. */
    calendarConnectError?: string | undefined;
}

export const Route = createFileRoute('/_authenticated/settings')({
    validateSearch: (search): SettingsSearch => {
        const { calendarConnected, calendarConnectError } = search;
        return {
            ...(typeof calendarConnected === 'string' ? { calendarConnected } : {}),
            ...(typeof calendarConnectError === 'string' ? { calendarConnectError } : {}),
        };
    },
    component: SettingsPage,
});

function SettingsPage() {
    const { db } = Route.useRouteContext();
    const { account } = useAppData();

    return (
        <Box className={styles.pageWrapper}>
            <Typography
                variant="h5"
                sx={{
                    fontWeight: 600,
                    mb: 3,
                }}
            >
                Settings
            </Typography>
            {/* Account section */}
            <Paper variant="outlined" className={styles.section}>
                <Box className={styles.sectionContent}>
                    <Typography
                        variant="subtitle1"
                        sx={{
                            fontWeight: 600,
                            mb: 0.5,
                        }}
                    >
                        Account
                    </Typography>
                    <Typography
                        variant="body2"
                        sx={{
                            color: 'text.secondary',
                        }}
                    >
                        {account?.name ?? '—'} · {account?.email ?? '—'}
                    </Typography>
                </Box>
            </Paper>
            {/* Appearance section */}
            <AppearanceSection />
            {/* Calendar sync section */}
            <Paper variant="outlined" className={styles.section}>
                <Box className={styles.sectionContent}>
                    <Typography
                        variant="subtitle1"
                        sx={{
                            fontWeight: 600,
                            mb: 0.5,
                        }}
                    >
                        Calendar Sync
                    </Typography>
                    <Typography
                        variant="body2"
                        sx={{
                            color: 'text.secondary',
                            mb: 2,
                        }}
                    >
                        Connect a Google Calendar account to sync calendar items bidirectionally. Changes made here or in Google Calendar stay in sync
                        automatically.
                    </Typography>
                    <Divider className={styles.divider} />
                    <CalendarIntegrations db={db} />
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
                    <Typography
                        variant="subtitle1"
                        sx={{
                            fontWeight: 600,
                            mb: 0.5,
                        }}
                    >
                        App
                    </Typography>
                    <Typography
                        variant="body2"
                        sx={{
                            color: 'text.secondary',
                        }}
                    >
                        Getting Things Done — offline-first GTD productivity app.
                    </Typography>
                    <Typography
                        variant="caption"
                        component="p"
                        sx={{
                            color: 'text.secondary',
                            mt: 1,
                        }}
                    >
                        Version: {__COMMIT_HASH__}
                    </Typography>
                </Box>
            </Paper>
        </Box>
    );
}

function AppearanceSection() {
    const { mode, setMode } = useColorScheme();
    const [themeId, setThemeId] = useState<ColorThemeId>(getColorTheme);

    function onThemeChange(id: ColorThemeId) {
        setThemeId(id);
        setColorTheme(id);
    }

    return (
        <Paper variant="outlined" className={styles.section}>
            <Box className={styles.sectionContent}>
                <Typography
                    variant="subtitle1"
                    sx={{
                        fontWeight: 600,
                        mb: 0.5,
                    }}
                >
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
                                <Typography
                                    variant="caption"
                                    sx={{
                                        color: 'text.secondary',
                                    }}
                                >
                                    Follows your OS setting
                                </Typography>
                            </Box>
                        }
                    />
                    <FormControlLabel value="dark" control={<Radio size="small" />} label={<Typography variant="body2">Dark</Typography>} />
                </RadioGroup>
                <Divider className={styles.divider} />
                <Typography
                    variant="body2"
                    sx={{
                        fontWeight: 500,
                        mb: 1,
                    }}
                >
                    Color theme
                </Typography>
                <Box className={styles.themeGrid}>
                    {COLOR_THEMES.map((t) => (
                        <ButtonBase
                            key={t.id}
                            className={classNames(styles.themeSwatch, themeId === t.id && styles.themeSwatchSelected)}
                            onClick={() => onThemeChange(t.id)}
                            aria-label={t.label}
                            aria-pressed={themeId === t.id}
                        >
                            <Box className={styles.swatchColors}>
                                <span className={styles.swatchCircle} style={{ backgroundColor: t.primary }} />
                                <span className={styles.swatchCircle} style={{ backgroundColor: t.secondary }} />
                            </Box>
                            <Typography variant="caption" className={styles.swatchLabel}>
                                {t.label}
                            </Typography>
                        </ButtonBase>
                    ))}
                </Box>
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
                <Typography
                    variant="subtitle1"
                    sx={{
                        fontWeight: 600,
                        mb: 0.5,
                    }}
                >
                    Calendar horizon
                </Typography>
                <Typography
                    variant="body2"
                    sx={{
                        color: 'text.secondary',
                        mb: 2,
                    }}
                >
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
                <Typography
                    variant="subtitle1"
                    sx={{
                        fontWeight: 600,
                        mb: 0.5,
                    }}
                >
                    Inbox
                </Typography>
                <Typography
                    variant="body2"
                    sx={{
                        color: 'text.secondary',
                        mb: 2,
                    }}
                >
                    How you prefer to edit and clarify items — applies to the inbox and all other pages.
                </Typography>
                <RadioGroup value={clarifyMode} onChange={(e) => onChange(parseClarifyMode(e.target.value))}>
                    <FormControlLabel
                        value="dialog"
                        control={<Radio size="small" />}
                        label={
                            <Box>
                                <Typography variant="body2">Dialog</Typography>
                                <Typography
                                    variant="caption"
                                    sx={{
                                        color: 'text.secondary',
                                    }}
                                >
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
                                <Typography
                                    variant="caption"
                                    sx={{
                                        color: 'text.secondary',
                                    }}
                                >
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
                                <Typography
                                    variant="caption"
                                    sx={{
                                        color: 'text.secondary',
                                    }}
                                >
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
                                <Typography
                                    variant="caption"
                                    sx={{
                                        color: 'text.secondary',
                                    }}
                                >
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
                                <Typography
                                    variant="caption"
                                    sx={{
                                        color: 'text.secondary',
                                    }}
                                >
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
                <Typography
                    variant="subtitle1"
                    sx={{
                        fontWeight: 600,
                        mb: 0.5,
                    }}
                >
                    Routine indicator
                </Typography>
                <Typography
                    variant="body2"
                    sx={{
                        color: 'text.secondary',
                        mb: 1,
                    }}
                >
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

// State machine driving the Notifications UI.
// - 'unsupported'    — browser lacks Notification / SW / PushManager APIs.
// - 'denied'         — user (or browser) blocked permission; only fixable via site settings.
// - 'needsPermission'— permission is 'default'; show "Enable notifications".
// - 'needsRegister'  — permission OK but the server has no subscription row for this device.
// - 'enabled'        — both browser permission and server-side row are present.
// - 'loading'        — pre-flight while polling /push/status.
type NotificationStatus = 'unsupported' | 'denied' | 'needsPermission' | 'needsRegister' | 'enabled' | 'loading';

function isBrowserPushCapable() {
    return typeof Notification !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
}

function NotificationsSection({ db }: { db: IDBPDatabase<MyDB> }) {
    const [status, setStatus] = useState<NotificationStatus>(() => (isBrowserPushCapable() ? 'loading' : 'unsupported'));
    const [isRequesting, startRequesting] = useTransition();

    // Resolves the current state by combining the browser's authoritative `Notification.permission`
    // with a `/push/status` round-trip — both must be OK for the section to show "enabled".
    const refreshStatus = useCallback(async () => {
        if (!isBrowserPushCapable()) {
            setStatus('unsupported');
            return;
        }
        if (Notification.permission === 'denied') {
            setStatus('denied');
            return;
        }
        if (Notification.permission === 'default') {
            setStatus('needsPermission');
            return;
        }
        // Permission is granted — verify the server still holds a subscription row.
        const deviceId = await getOrCreateDeviceId(db);
        const { registered } = await getPushStatus(deviceId);
        setStatus(registered ? 'enabled' : 'needsRegister');
    }, [db]);

    useEffect(() => {
        void refreshStatus();
    }, [refreshStatus]);

    function onEnableOrRegister() {
        startRequesting(async () => {
            try {
                await requestAndRegisterPushSubscription(db);
            } finally {
                // Re-derive status from the browser + server regardless of whether the call succeeded.
                await refreshStatus();
            }
        });
    }

    return (
        <Paper variant="outlined" className={styles.section}>
            <Box className={styles.sectionContent}>
                <Typography
                    variant="subtitle1"
                    sx={{
                        fontWeight: 600,
                        mb: 0.5,
                    }}
                >
                    Notifications
                </Typography>
                <Typography
                    variant="body2"
                    sx={{
                        color: 'text.secondary',
                        mb: 2,
                    }}
                >
                    Push notifications keep your items in sync across devices, even when the app is closed.
                </Typography>
                <NotificationsBody status={status} isRequesting={isRequesting} onEnableOrRegister={onEnableOrRegister} />
            </Box>
        </Paper>
    );
}

interface NotificationsBodyProps {
    status: NotificationStatus;
    isRequesting: boolean;
    onEnableOrRegister: () => void;
}

function NotificationsBody({ status, isRequesting, onEnableOrRegister }: NotificationsBodyProps) {
    if (status === 'loading') {
        return (
            <Typography
                variant="body2"
                sx={{
                    color: 'text.secondary',
                    fontStyle: 'italic',
                }}
            >
                Checking notification status…
            </Typography>
        );
    }
    if (status === 'unsupported') {
        return (
            <Typography
                variant="body2"
                sx={{
                    color: 'text.secondary',
                    fontStyle: 'italic',
                }}
            >
                Push notifications are not supported in this browser.
            </Typography>
        );
    }
    if (status === 'denied') {
        return (
            <Typography
                variant="body2"
                sx={{
                    color: 'text.secondary',
                    fontStyle: 'italic',
                }}
            >
                Notifications are blocked. To enable them, update your browser's site permissions.
            </Typography>
        );
    }
    if (status === 'enabled') {
        return (
            <Typography
                variant="body2"
                sx={{
                    color: 'success.main',
                }}
            >
                Notifications enabled.
            </Typography>
        );
    }
    // needsPermission or needsRegister — both resolve via the same one-click flow:
    // requestAndRegisterPushSubscription handles both prompting and re-subscribing.
    const label = status === 'needsPermission' ? 'Enable notifications' : 'Re-enable notifications';
    return (
        <Button variant="outlined" size="small" onClick={onEnableOrRegister} disabled={isRequesting}>
            {isRequesting ? 'Requesting…' : label}
        </Button>
    );
}
