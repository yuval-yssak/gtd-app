import { createFileRoute, Link } from '@tanstack/react-router';
import type { IDBPDatabase } from 'idb';
import { Suspense, useCallback, useEffect, useState, useTransition } from 'react';
import { getPushStatus } from '../../api/pushApi';
import { AppErrorBoundary } from '../../components/AppErrorBoundary';
import { AccountDataSection } from '../../components/settings/AccountDataSection';
import { CalendarIntegrations } from '../../components/settings/CalendarIntegrations';
import { CalendarIntegrationsSkeleton } from '../../components/settings/CalendarIntegrationsSkeleton';
import { ConnectClaude } from '../../components/settings/ConnectClaude';
import { ConnectedDevices } from '../../components/settings/ConnectedDevices';
import { PersonalApiTokens } from '../../components/settings/PersonalApiTokens';
import { SettingsSection } from '../../components/settings/SettingsSection';
import { useAppData } from '../../contexts/AppDataProvider';
import { getOrCreateDeviceId } from '../../db/deviceId';
import { requestAndRegisterPushSubscription } from '../../db/pushSubscription';
import { Button, RadioGroup, type RadioOption, Select, Switch, Text } from '../../designSystem';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { APP_NAME, METHOD_NAME } from '../../lib/appName';
import { setShowBriefs, useShowBriefs } from '../../lib/briefPreference';
import { getCalendarHorizonMonths, setCalendarHorizonMonths } from '../../lib/calendarHorizon';
import { type ColorSchemePreference, setColorSchemePreference, useColorSchemePreference } from '../../lib/colorScheme';
import { LEGAL_DOCUMENTS } from '../../lib/legalDocuments';
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
    useDocumentTitle('Settings');
    const { db } = Route.useRouteContext();
    const { account } = useAppData();

    return (
        <div className={styles.pageWrapper}>
            <Text as="h1" variant="title" className={styles.pageTitle}>
                Settings
            </Text>
            <SettingsSection title="Account" description={`${account?.name ?? '—'} · ${account?.email ?? '—'}`} />
            <AppearanceSection />
            <SettingsSection
                title="Calendar Sync"
                description="Connect a Google Calendar account to sync calendar items bidirectionally. Changes made here or in Google Calendar stay in sync automatically."
                isDivided
            >
                {/* Scoped boundary: only the calendar section waits on its network reads — the rest
                    of the settings page renders immediately. The skeleton reserves the section's
                    final height so content sharpens in without shifting the sections below it. */}
                <AppErrorBoundary mode="inline" title="Couldn't load calendar settings">
                    <Suspense fallback={<CalendarIntegrationsSkeleton />}>
                        <CalendarIntegrations />
                    </Suspense>
                </AppErrorBoundary>
            </SettingsSection>
            <CalendarHorizonSection />
            <RoutineIndicatorSection />
            <WeeklyReviewSection />
            <NotificationsSection db={db} />
            <SettingsSection
                title="Connected devices"
                description="Every device signed in to this account keeps its own sync position, and sync history is retained until the slowest device catches up. Remove a device you no longer use to free the history it is holding on to."
                isDivided
            >
                <ConnectedDevices db={db} />
            </SettingsSection>
            {/* Connect Claude via the hosted MCP endpoint (OAuth, no token) */}
            <SettingsSection
                title="Connect Claude"
                description={`Let Claude capture, clarify and review your items in conversation. Add ${APP_NAME} as a connector in Claude, then sign in. No install or token needed.`}
                isDivided
            >
                <ConnectClaude />
            </SettingsSection>
            <SettingsSection
                title="Personal API tokens"
                description={
                    <>
                        Bearer tokens for the public <code>/v1</code> API. Use them to integrate this account with shortcuts, automations, or the local MCP
                        server. Connecting Claude doesn't need one; use Connect Claude above.
                    </>
                }
                isDivided
            >
                <PersonalApiTokens />
            </SettingsSection>
            {/* Data export + account deletion (GDPR portability / erasure) */}
            <AccountDataSection db={db} account={account} />
            <SettingsSection title="App" description={`${APP_NAME} — an offline-first productivity app built around the ${METHOD_NAME} method.`}>
                <Text as="p" variant="caption" tone="secondary">
                    Version: {__COMMIT_HASH__}
                </Text>
                {/* The only in-app route to the legal documents; signed-out visitors get them from
                    the sign-in card and the landing page. */}
                <nav aria-label="Legal pages" className={styles.legalLinks}>
                    <Link to={LEGAL_DOCUMENTS.privacy.path} data-testid="settingsPrivacyLink">
                        {LEGAL_DOCUMENTS.privacy.title}
                    </Link>
                    <Link to={LEGAL_DOCUMENTS.terms.path} data-testid="settingsTermsLink">
                        {LEGAL_DOCUMENTS.terms.title}
                    </Link>
                </nav>
            </SettingsSection>
        </div>
    );
}

const COLOR_SCHEME_OPTIONS: RadioOption<ColorSchemePreference>[] = [
    { value: 'light', label: 'Light' },
    { value: 'system', label: 'System', description: 'Follows your OS setting' },
    { value: 'dark', label: 'Dark' },
];

function AppearanceSection() {
    const preference = useColorSchemePreference();
    return (
        <SettingsSection title="Appearance">
            <RadioGroup
                aria-label="Appearance"
                value={preference}
                onValueChange={setColorSchemePreference}
                options={COLOR_SCHEME_OPTIONS}
                data-testid="colorSchemeRadio"
            />
        </SettingsSection>
    );
}

function WeeklyReviewSection() {
    const isShowBriefsOn = useShowBriefs();

    return (
        <SettingsSection
            title="Weekly review"
            description={
                <>
                    A brief is a one-line condensation of an item's title and notes. When shown, review cards lead with the brief and fold the notes behind
                    &ldquo;Show notes&rdquo;. This device only.
                </>
            }
        >
            <Switch label="Show briefs" checked={isShowBriefsOn} onCheckedChange={setShowBriefs} data-testid="settingsShowBriefsToggle" />
        </SettingsSection>
    );
}

const HORIZON_OPTIONS = [1, 2, 3, 4, 6, 9, 12].map((months) => ({ value: String(months), label: months === 1 ? '1 month' : `${months} months` }));

function CalendarHorizonSection() {
    const [horizon, setHorizon] = useState(() => getCalendarHorizonMonths());

    function onChange(months: number) {
        setHorizon(months);
        setCalendarHorizonMonths(months);
    }

    return (
        <SettingsSection
            title="Calendar horizon"
            description="How far ahead to generate calendar items for recurring routines. Existing routines are not affected until their next edit or item completion."
        >
            <Select
                aria-label="Calendar horizon"
                size="sm"
                value={String(horizon)}
                onValueChange={(months) => onChange(Number(months))}
                options={HORIZON_OPTIONS}
                className={styles.horizonSelect}
            />
        </SettingsSection>
    );
}

const ROUTINE_INDICATOR_OPTIONS: RadioOption<RoutineIndicatorStyle>[] = [
    { value: 'icon', label: 'Loop icon' },
    { value: 'colorAccent', label: 'Color dot' },
    { value: 'chip', label: 'Chip label' },
    { value: 'none', label: 'None' },
];

function RoutineIndicatorSection() {
    const [style, setStyle] = useState<RoutineIndicatorStyle>(() => getRoutineIndicatorStyle());

    function onChange(newStyle: RoutineIndicatorStyle) {
        setStyle(newStyle);
        setRoutineIndicatorStyle(newStyle);
    }

    return (
        <SettingsSection title="Routine indicator" description="How items linked to a routine are marked in lists.">
            <RadioGroup aria-label="Routine indicator" value={style} onValueChange={onChange} options={ROUTINE_INDICATOR_OPTIONS} />
        </SettingsSection>
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
        <SettingsSection title="Notifications" description="Push notifications keep your items in sync across devices, even when the app is closed.">
            <NotificationsBody status={status} isRequesting={isRequesting} onEnableOrRegister={onEnableOrRegister} />
        </SettingsSection>
    );
}

interface NotificationsBodyProps {
    status: NotificationStatus;
    isRequesting: boolean;
    onEnableOrRegister: () => void;
}

const NOTIFICATION_STATUS_NOTES: Partial<Record<NotificationStatus, string>> = {
    loading: 'Checking notification status…',
    unsupported: 'Push notifications are not supported in this browser.',
    denied: "Notifications are blocked. To enable them, update your browser's site permissions.",
};

function NotificationsBody({ status, isRequesting, onEnableOrRegister }: NotificationsBodyProps) {
    const note = NOTIFICATION_STATUS_NOTES[status];
    if (note !== undefined) {
        return (
            <Text variant="bodySm" tone="secondary" className={styles.statusNote}>
                {note}
            </Text>
        );
    }
    if (status === 'enabled') {
        return (
            <Text variant="bodySm" tone="success">
                Notifications enabled.
            </Text>
        );
    }
    // needsPermission or needsRegister — both resolve via the same one-click flow:
    // requestAndRegisterPushSubscription handles both prompting and re-subscribing.
    const label = status === 'needsPermission' ? 'Enable notifications' : 'Re-enable notifications';
    return (
        <Button variant="outline" size="sm" onClick={onEnableOrRegister} disabled={isRequesting}>
            {isRequesting ? 'Requesting…' : label}
        </Button>
    );
}
