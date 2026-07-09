import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import InputLabel from '@mui/material/InputLabel';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Select from '@mui/material/Select';
import Switch from '@mui/material/Switch';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useNavigate, useSearch } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { startTransition, use, useCallback, useEffect, useRef, useState, useTransition } from 'react';
import {
    type CalendarIntegration,
    type CalendarSyncConfig,
    createSyncConfig,
    deleteIntegration,
    deleteSyncConfig,
    type GoogleCalendar,
    initiateGoogleCalendarAuth,
    listCalendars,
    type RelinkSweepCounts,
    relinkCalendarMarkers,
    syncIntegration,
    type UnlinkAction,
    updateSyncConfig,
} from '../../api/calendarApi';
import { useAppData } from '../../contexts/AppDataProvider';
import { getCalendarIntegrationsResource, type IntegrationWithDetails, invalidateCalendarIntegrationsResource } from '../../data/calendarIntegrationsResource';
import { hasAtLeastOne, type NonEmptyArray } from '../../lib/typeUtils';
import type { StoredAccount } from '../../types/MyDB';
import { buildCalendarPickerRows, defaultCalendarId } from './calendarPickerOrder';

/**
 * Runs a calendar MUTATION with the active Better Auth session pinned to the managed account (see
 * AppData.withActiveAccountSession). Threaded from the root component down to every dialog/hook that
 * mutates calendar state, so each request resolves under the right user even when the ambient cookie
 * session has drifted (Bug A). Reads are intentionally left unwrapped — they run under the ambient
 * unified session.
 */
type WithActiveAccountSession = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Maps a `createSyncConfig` failure to a user-facing message. The thrown Error from `apiFetch`
 * carries the format `Calendar API error <status>: <body>`, so we sniff for the 409 conflict to
 * tell the user the calendar is already linked instead of a generic "try again".
 */
function formatSaveCalendarError(err: unknown): string {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('409')) {
        return 'This calendar is already being synced. Choose a different calendar.';
    }
    // 404 = the integration this dialog opened against no longer exists server-side (a stale row from
    // a disconnect/reconnect). The parent re-reads the integration list; tell the user to retry. Note
    // this message surfaces only on the row-level "Choose calendar" re-entry — the auto-opened post-
    // OAuth dialog unmounts (onStaleIntegration closes it) before its isMountedRef-guarded saveError
    // renders, so there the user instead lands back on the refreshed "No calendar selected" CTA.
    if (isStaleIntegrationError(err)) {
        return 'This connection is no longer available — it was refreshed. Reopen "Choose a calendar" and try again.';
    }
    return 'Failed to save calendar selection. Please try again.';
}

/** True when an `apiFetch` Error reports a 404 — the integration id is stale (disconnect/reconnect race). */
export function isStaleIntegrationError(err: unknown): boolean {
    return err instanceof Error && err.message.includes('404');
}

/**
 * Picks which integration the post-OAuth picker opens against. `connectedId` is the persisted id the
 * server put in the `calendarConnected` redirect param — prefer the row that matches it exactly so the
 * picker never targets a stale id that no longer exists server-side (the disconnect/reconnect 404).
 * Falls back to the newest-by-createdTs row for the legacy redirect that carried a bare "1".
 */
export function pickConnectedIntegration(details: NonEmptyArray<IntegrationWithDetails>, connectedId: string): IntegrationWithDetails {
    const matched = details.find((d) => d.integration._id === connectedId);
    return matched ?? details.reduce((a, b) => (a.integration.createdTs > b.integration.createdTs ? a : b));
}

function formatAddCalendarError(err: unknown): string {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('409')) {
        return 'This calendar is already being synced.';
    }
    return 'Failed to add calendar. Please try again.';
}

/** Fetches the calendar list for an integration, with unmount-safe cancellation. */
function useCalendarList(integrationId: string): { calendars: GoogleCalendar[]; isLoading: boolean; fetchError: string | null } {
    const [calendars, setCalendars] = useState<GoogleCalendar[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [fetchError, setFetchError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        listCalendars(integrationId)
            .then((cals) => {
                // Ordering is owned by calendarSelectRows/defaultCalendarId (they sort internally), so
                // we store the raw list and let the picker decide order — no need to pre-sort here.
                if (!cancelled) setCalendars(cals);
            })
            .catch(() => {
                if (!cancelled) setFetchError('Could not load calendars.');
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [integrationId]);

    return { calendars, isLoading, fetchError };
}

export function CalendarIntegrations() {
    // `resource` is the promise the whole section suspends on. A refresh swaps in a fresh promise
    // inside startTransition (below) so mutations re-read without flashing the Suspense fallback.
    const [resource, setResource] = useState(getCalendarIntegrationsResource);
    const details = use(resource);
    const [chooseCalendarFor, setChooseCalendarFor] = useState<CalendarIntegration | null>(null);
    const { account, loggedInAccounts, syncAndRefresh, withActiveAccountSession } = useAppData();
    const navigate = useNavigate();
    // calendarConnected and calendarConnectError are set by the OAuth callback redirect; the first
    // auto-opens the calendar picker, the second renders a mismatch error inline.
    const { calendarConnected, calendarConnectError } = useSearch({ from: '/_authenticated/settings' });

    // Drops the resource cache and re-reads. The new promise is swapped in inside a transition so
    // the current rows stay on screen until the fresh tree resolves — no fallback flash.
    const refreshIntegrations = useCallback(() => {
        const next = invalidateCalendarIntegrationsResource();
        startTransition(() => setResource(next));
    }, []);

    useEffect(() => {
        // After the OAuth redirect lands (calendarConnected set), auto-open the picker, then strip
        // the query param so a reload doesn't reopen it. `details` already holds the resolved
        // integrations — no extra fetch needed here.
        if (!calendarConnected || !hasAtLeastOne(details)) {
            return;
        }
        // calendarConnected carries the PERSISTED integration id; target that exact row so the picker
        // never opens against a stale id that no longer exists server-side (the disconnect/reconnect 404).
        const target = pickConnectedIntegration(details, calendarConnected);
        setChooseCalendarFor(target.integration);
        // Functional `search` form strips only this param without clobbering siblings (e.g. an
        // existing calendarConnectError the user hasn't dismissed yet).
        navigate({ to: '/settings', search: (prev) => ({ ...prev, calendarConnected: undefined }), replace: true }).catch(() => {});
    }, [calendarConnected, details, navigate]);

    function dismissMismatchError() {
        // Clear the query param via navigate(replace) so refreshing the page doesn't re-show the error.
        navigate({ to: '/settings', search: (prev) => ({ ...prev, calendarConnectError: undefined }), replace: true }).catch(() => {});
    }

    function onConnectActiveAccount() {
        if (!account) {
            return;
        }
        // Active-user only: hand the active account's email as login_hint so Google's picker
        // pre-selects it. initiateGoogleCalendarAuth first re-asserts the API-origin active session
        // to this account (cookie/IDB can drift), then redirects; the server attaches the integration
        // to the account that owns the eventually-authorized Google identity. Fire-and-forget: the
        // function ends in a full-page navigation, so there's nothing to await here.
        initiateGoogleCalendarAuth(account.email).catch(() => {});
    }

    return (
        <Box>
            <ActiveAccountScopeNotice account={account} hasMultipleAccounts={loggedInAccounts.length > 1} />
            {calendarConnectError === 'mismatch' && <ConnectMismatchError onDismiss={dismissMismatchError} />}
            {details.length === 0 && (
                <Typography
                    variant="body2"
                    sx={{
                        color: 'text.secondary',
                        fontStyle: 'italic',
                        mb: 2,
                    }}
                >
                    No calendars connected.
                </Typography>
            )}
            {details.map((detail) => (
                <IntegrationRow
                    key={detail.integration._id}
                    detail={detail}
                    onIntegrationsChanged={refreshIntegrations}
                    onChooseCalendar={() => setChooseCalendarFor(detail.integration)}
                    withActiveAccountSession={withActiveAccountSession}
                />
            ))}
            <Button variant="outlined" size="small" onClick={onConnectActiveAccount} disabled={!account}>
                {account ? `Connect Google Calendar for ${account.email}` : 'Connect Google Calendar'}
            </Button>
            {chooseCalendarFor && (
                <ChooseCalendarDialog
                    integration={chooseCalendarFor}
                    onClose={() => setChooseCalendarFor(null)}
                    onSaved={() => {
                        setChooseCalendarFor(null);
                        refreshIntegrations();
                        syncAndRefresh().catch(() => {});
                    }}
                    onStaleIntegration={() => {
                        // Stale integration id (disconnect/reconnect race): close the dialog and re-read
                        // the list so the next attempt targets the live integration row.
                        setChooseCalendarFor(null);
                        refreshIntegrations();
                    }}
                    withActiveAccountSession={withActiveAccountSession}
                />
            )}
        </Box>
    );
}

/**
 * Banner above the integration list that names the active account and tells the user to switch
 * accounts (via the account switcher) if they want to manage a different one's calendars. Only
 * useful when more than one account is signed in on this device — with a single account the
 * Account section above already shows the email and there's nothing to switch to.
 */
function ActiveAccountScopeNotice({ account, hasMultipleAccounts }: { account: StoredAccount | null; hasMultipleAccounts: boolean }) {
    if (!account || !hasMultipleAccounts) {
        return null;
    }
    return (
        <Box
            sx={{
                mb: 2,
                p: 1.25,
                borderRadius: 1,
                backgroundColor: 'action.hover',
            }}
        >
            <Typography variant="body2" sx={{ fontWeight: 500 }}>
                Managing calendars for <strong>{account.email}</strong>
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                To connect or disconnect a different account's calendar, switch to that account first.
            </Typography>
        </Box>
    );
}

function ConnectMismatchError({ onDismiss }: { onDismiss: () => void }) {
    return (
        <Box sx={{ mb: 2, p: 1.5, border: 1, borderColor: 'error.main', borderRadius: 1 }}>
            <Typography
                variant="body2"
                sx={{
                    color: 'error.main',
                    fontWeight: 500,
                    mb: 0.5,
                }}
            >
                Couldn't connect that Google Calendar account
            </Typography>
            <Typography
                variant="caption"
                sx={{
                    color: 'text.secondary',
                    display: 'block',
                }}
            >
                The Google account you authorized didn't match the one you selected. Tokens were revoked and no calendar was added.
            </Typography>
            <Button size="small" sx={{ mt: 1 }} onClick={onDismiss}>
                Dismiss
            </Button>
        </Box>
    );
}

/**
 * Local mirror of the resource's sync configs for one integration. Seeded from the resolved
 * resource so the row renders immediately (no per-row spinner), then owned locally so optimistic
 * mutations (toggle, set-default, remove) update in place without a round-trip. `onReloaded`
 * re-seeds from `seed` when the resource refreshes (e.g. after adding a calendar).
 */
function useLocalSyncConfigs(seed: CalendarSyncConfig[]): {
    configs: CalendarSyncConfig[];
    setConfigs: React.Dispatch<React.SetStateAction<CalendarSyncConfig[]>>;
} {
    const [configs, setConfigs] = useState(seed);
    // Re-seed when the upstream resource provides a new array identity (post-refresh). Comparing by
    // reference is enough: invalidateCalendarIntegrationsResource() always builds fresh arrays.
    const seedRef = useRef(seed);
    if (seedRef.current !== seed) {
        seedRef.current = seed;
        setConfigs(seed);
    }
    return { configs, setConfigs };
}

interface IntegrationRowProps {
    detail: IntegrationWithDetails;
    /** Refreshes the integrations resource after a structural change (disconnect, calendar added). */
    onIntegrationsChanged: () => void;
    onChooseCalendar: () => void;
    withActiveAccountSession: WithActiveAccountSession;
}

interface SyncConfigActionsDeps {
    setConfigs: React.Dispatch<React.SetStateAction<CalendarSyncConfig[]>>;
    // Invalidates the cached integrations resource after a successful mutation. Without this the
    // optimistic setConfigs only touches this row's local state — the module-level resource promise
    // still holds the pre-mutation snapshot, so navigating away and back re-seeds the stale value
    // (the change only "sticks" after a full reload, which rebuilds the module cache from the server).
    invalidateResource: () => void;
    withActiveAccountSession: WithActiveAccountSession;
}

/** Manages sync config mutations with error handling and optimistic state updates. */
function useSyncConfigActions(
    integrationId: string,
    { setConfigs, invalidateResource, withActiveAccountSession }: SyncConfigActionsDeps,
): { actions: ConfigActions; actionError: string | null } {
    const [actionError, setActionError] = useState<string | null>(null);

    const onToggleEnabled = useCallback(
        async (config: CalendarSyncConfig) => {
            setActionError(null);
            try {
                const updated = await withActiveAccountSession(() => updateSyncConfig(integrationId, config._id, { enabled: !config.enabled }));
                setConfigs((prev) => prev.map((c) => (c._id === config._id ? updated : c)));
                invalidateResource();
            } catch {
                setActionError('Failed to update calendar. Please try again.');
            }
        },
        [integrationId, setConfigs, invalidateResource, withActiveAccountSession],
    );

    const onSetDefault = useCallback(
        async (config: CalendarSyncConfig) => {
            setActionError(null);
            try {
                const updated = await withActiveAccountSession(() => updateSyncConfig(integrationId, config._id, { isDefault: true }));
                // The server unsets isDefault on all sibling configs — refresh to get accurate state.
                setConfigs((prev) => prev.map((c) => (c._id === config._id ? updated : { ...c, isDefault: false })));
                invalidateResource();
            } catch {
                setActionError('Failed to set default calendar. Please try again.');
            }
        },
        [integrationId, setConfigs, invalidateResource, withActiveAccountSession],
    );

    const onRemove = useCallback(
        async (config: CalendarSyncConfig) => {
            setActionError(null);
            try {
                await withActiveAccountSession(() => deleteSyncConfig(integrationId, config._id));
                setConfigs((prev) => prev.filter((c) => c._id !== config._id));
                invalidateResource();
            } catch {
                setActionError('Failed to remove calendar. Please try again.');
            }
        },
        [integrationId, setConfigs, invalidateResource, withActiveAccountSession],
    );

    return { actions: { onToggleEnabled, onSetDefault, onRemove }, actionError };
}

/** Wraps the sync-now action with loading, error, and unmount-safety state. */
function useSyncNow(
    integrationId: string,
    withActiveAccountSession: WithActiveAccountSession,
): { onSyncNow: () => void; isSyncing: boolean; syncError: string | null } {
    const [isSyncing, setIsSyncing] = useState(false);
    const [syncError, setSyncError] = useState<string | null>(null);
    const { syncAndRefresh } = useAppData();
    const isMountedRef = useRef(true);
    useEffect(
        () => () => {
            isMountedRef.current = false;
        },
        [],
    );

    const onSyncNow = useCallback(async () => {
        setIsSyncing(true);
        setSyncError(null);
        try {
            await withActiveAccountSession(() => syncIntegration(integrationId));
            await syncAndRefresh();
        } catch {
            if (isMountedRef.current) setSyncError('Sync failed. Please try again.');
        } finally {
            if (isMountedRef.current) setIsSyncing(false);
        }
    }, [integrationId, syncAndRefresh, withActiveAccountSession]);

    return { onSyncNow, isSyncing, syncError };
}

/** Field-wise sum of two sweeps' counts — the button repairs every logged-in account and reports one total. */
export function addRepairCounts(a: RelinkSweepCounts, b: RelinkSweepCounts): RelinkSweepCounts {
    return {
        relinkedItems: a.relinkedItems + b.relinkedItems,
        relinkedRoutines: a.relinkedRoutines + b.relinkedRoutines,
        recreatedEvents: a.recreatedEvents + b.recreatedEvents,
        trashedItems: a.trashedItems + b.trashedItems,
        deactivatedRoutines: a.deactivatedRoutines + b.deactivatedRoutines,
        clearedMarkers: a.clearedMarkers + b.clearedMarkers,
    };
}

/**
 * Human-readable one-liner for the relink sweep's counts. Exported for unit tests.
 * Repaired categories are listed; an all-zero sweep reads as "nothing needed repair".
 */
export function summarizeRepair(counts: RelinkSweepCounts): string {
    const parts = [
        counts.relinkedItems > 0 ? `${counts.relinkedItems} item${counts.relinkedItems === 1 ? '' : 's'} relinked` : null,
        counts.relinkedRoutines > 0 ? `${counts.relinkedRoutines} routine${counts.relinkedRoutines === 1 ? '' : 's'} relinked` : null,
        counts.recreatedEvents > 0 ? `${counts.recreatedEvents} event${counts.recreatedEvents === 1 ? '' : 's'} recreated on Google` : null,
        counts.trashedItems > 0 ? `${counts.trashedItems} cancelled item${counts.trashedItems === 1 ? '' : 's'} trashed` : null,
        counts.deactivatedRoutines > 0 ? `${counts.deactivatedRoutines} ended routine${counts.deactivatedRoutines === 1 ? '' : 's'} paused` : null,
        counts.clearedMarkers > 0 ? `${counts.clearedMarkers} stale link${counts.clearedMarkers === 1 ? '' : 's'} cleared` : null,
    ].filter((part): part is string => part !== null);
    return parts.length > 0 ? `Repaired: ${parts.join(', ')}.` : 'Everything is already linked — nothing needed repair.';
}

/**
 * Runs the relink sweep once per LOGGED-IN account — pinned via `withOwnerSession` — and returns the
 * summed counts. Not just the app-active account: the settings rows render from the ambient session,
 * which can drift from the active account (the IDB-vs-cookie mismatch family), and a single-account
 * sweep then silently repairs the wrong user. Sweeping every account is idempotent and drift-immune.
 *
 * Sequential, not Promise.all — `withOwnerSession` swaps the shared Better Auth active session;
 * concurrent swaps would race each other's pinning. Dependency-injected and exported so the
 * composition (per-account fan-out, ordering, fallback, aggregation) is unit-testable.
 */
export async function sweepAllAccounts(
    accountIds: string[],
    withOwnerSession: <T>(userId: string, task: () => Promise<T>) => Promise<T>,
    runSweep: () => Promise<RelinkSweepCounts>,
): Promise<RelinkSweepCounts> {
    const sweeps: RelinkSweepCounts[] = [];
    for (const accountId of accountIds) {
        sweeps.push(await withOwnerSession(accountId, runSweep));
    }
    if (!hasAtLeastOne(sweeps)) {
        // No tracked accounts (shouldn't happen on the settings page) — run under the ambient session.
        sweeps.push(await runSweep());
    }
    return sweeps.reduce(addRepairCounts, zeroRepairCounts());
}

/** All-zero sweep counts — the identity element for `addRepairCounts`. */
export function zeroRepairCounts(): RelinkSweepCounts {
    return { relinkedItems: 0, relinkedRoutines: 0, recreatedEvents: 0, trashedItems: 0, deactivatedRoutines: 0, clearedMarkers: 0 };
}

/**
 * Wraps the repair-sync action (the server's stranded-marker relink sweep) with loading, error, and
 * result-summary state. The heavy lifting (per-account fan-out) lives in `sweepAllAccounts`. The
 * error branch is all-or-nothing on purpose: a partial server-side success is safe — the sweep is
 * idempotent, so re-clicking after a failure just finishes the job.
 */
function useRepairSync(): {
    onRepair: () => void;
    isRepairing: boolean;
    repairError: string | null;
    repairSummary: string | null;
} {
    const [isRepairing, setIsRepairing] = useState(false);
    const [repairError, setRepairError] = useState<string | null>(null);
    const [repairSummary, setRepairSummary] = useState<string | null>(null);
    const { loggedInAccounts, syncAndRefresh, withOwnerSession } = useAppData();
    const isMountedRef = useRef(true);
    useEffect(
        () => () => {
            isMountedRef.current = false;
        },
        [],
    );

    const onRepair = useCallback(async () => {
        setIsRepairing(true);
        setRepairError(null);
        setRepairSummary(null);
        try {
            const totals = await sweepAllAccounts(
                loggedInAccounts.map((account) => account.id),
                withOwnerSession,
                relinkCalendarMarkers,
            );
            // Pull the repair ops into IDB so the healed items/routines show up immediately.
            await syncAndRefresh();
            if (isMountedRef.current) setRepairSummary(summarizeRepair(totals));
        } catch {
            if (isMountedRef.current) setRepairError('Repair failed. Please try again.');
        } finally {
            if (isMountedRef.current) setIsRepairing(false);
        }
    }, [loggedInAccounts, syncAndRefresh, withOwnerSession]);

    return { onRepair, isRepairing, repairError, repairSummary };
}

function IntegrationRow({ detail, onIntegrationsChanged, onChooseCalendar, withActiveAccountSession }: IntegrationRowProps) {
    const { integration, calendars } = detail;
    const { configs, setConfigs } = useLocalSyncConfigs(detail.syncConfigs);
    // onIntegrationsChanged is refreshIntegrations: drops the cached resource + re-reads in a
    // transition. Passing it here makes toggle/set-default/remove durable across navigation, not
    // just local to this mount (see useSyncConfigActions' invalidateResource note).
    const { actions, actionError } = useSyncConfigActions(integration._id, {
        setConfigs,
        invalidateResource: onIntegrationsChanged,
        withActiveAccountSession,
    });
    const { onSyncNow, isSyncing, syncError } = useSyncNow(integration._id, withActiveAccountSession);
    const { onRepair, isRepairing, repairError, repairSummary } = useRepairSync();
    const [isDisconnectOpen, setIsDisconnectOpen] = useState(false);
    const [isAddCalendarOpen, setIsAddCalendarOpen] = useState(false);
    const { syncAndRefresh } = useAppData();

    // null calendars means the calendar-list fetch failed — surface it but keep the row usable.
    const calendarFetchError = calendars === null ? 'Could not load calendars.' : null;

    function resolveCalendarName(calendarId: string): string {
        return calendars?.find((c) => c.id === calendarId)?.name ?? calendarId;
    }

    // Calendars already being synced — used to filter the "add calendar" dropdown.
    const syncedCalendarIds = new Set(configs.map((c) => c.calendarId));
    const availableToAdd = (calendars ?? []).filter((c) => !syncedCalendarIds.has(c.id));

    const connectedSince = dayjs(integration.createdTs).format('MMM D, YYYY');
    const errorMessage = calendarFetchError ?? actionError ?? syncError ?? repairError;
    // Step 2: integrations require an explicit calendar choice. If the user dismissed the
    // post-OAuth dialog without picking one, surface a "choose one" CTA so they can resume.
    const hasNoCalendarChosen = configs.length === 0;

    return (
        <Box
            sx={{
                mb: 2,
            }}
        >
            <Divider sx={{ mb: 1.5 }} />
            <Typography
                variant="body2"
                sx={{
                    fontWeight: 600,
                    mb: 0.5,
                }}
            >
                Google Calendar
            </Typography>
            <Typography
                variant="caption"
                sx={{
                    color: 'text.secondary',
                    display: 'block',
                }}
            >
                Connected {connectedSince}
            </Typography>
            {errorMessage && (
                <Typography
                    variant="caption"
                    color="error"
                    sx={{
                        display: 'block',
                        mt: 1,
                    }}
                >
                    {errorMessage}
                </Typography>
            )}
            {hasNoCalendarChosen ? (
                <NoCalendarChosenRow onChooseCalendar={onChooseCalendar} />
            ) : (
                <SyncConfigList configs={configs} resolveCalendarName={resolveCalendarName} actions={actions} />
            )}
            <IntegrationActions
                isSyncing={isSyncing}
                isRepairing={isRepairing}
                hasAvailableCalendars={availableToAdd.length > 0}
                actions={{ onSyncNow, onRepair, onAddCalendar: () => setIsAddCalendarOpen(true), onDisconnect: () => setIsDisconnectOpen(true) }}
            />
            {repairSummary && (
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }} data-testid="repairSyncSummary">
                    {repairSummary}
                </Typography>
            )}
            <DisconnectDialog
                open={isDisconnectOpen}
                integrationId={integration._id}
                onClose={() => setIsDisconnectOpen(false)}
                onDisconnected={onIntegrationsChanged}
                withActiveAccountSession={withActiveAccountSession}
            />
            {isAddCalendarOpen && (
                <AddCalendarDialog
                    integrationId={integration._id}
                    availableCalendars={availableToAdd}
                    isFirstCalendar={configs.length === 0}
                    onClose={() => setIsAddCalendarOpen(false)}
                    withActiveAccountSession={withActiveAccountSession}
                    onAdded={() => {
                        setIsAddCalendarOpen(false);
                        // Refresh the resource (new config + shrunken add-list) and sync IDB so the
                        // newly synced calendar's events land locally.
                        onIntegrationsChanged();
                        syncAndRefresh().catch(() => {});
                    }}
                />
            )}
        </Box>
    );
}

function NoCalendarChosenRow({ onChooseCalendar }: { onChooseCalendar: () => void }) {
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
            <Typography
                variant="body2"
                sx={{
                    color: 'text.secondary',
                    fontStyle: 'italic',
                }}
            >
                No calendar selected — choose one
            </Typography>
            <Button size="small" onClick={onChooseCalendar}>
                Choose calendar
            </Button>
        </Box>
    );
}

interface IntegrationRowActions {
    onSyncNow: () => void;
    onRepair: () => void;
    onAddCalendar: () => void;
    onDisconnect: () => void;
}

interface IntegrationActionsProps {
    isSyncing: boolean;
    isRepairing: boolean;
    hasAvailableCalendars: boolean;
    actions: IntegrationRowActions;
}

function IntegrationActions({ isSyncing, isRepairing, hasAvailableCalendars, actions }: IntegrationActionsProps) {
    return (
        <Box sx={{ display: 'flex', gap: 1, mt: 1.5, flexWrap: 'wrap' }}>
            {hasAvailableCalendars && (
                <Button variant="outlined" size="small" onClick={actions.onAddCalendar}>
                    Add calendar
                </Button>
            )}
            {/* Tooltip children are wrapped in <span> so the tooltip keeps working while the button is disabled. */}
            <Tooltip title="Fetch the latest changes from Google Calendar right now, without waiting for automatic sync. Also pushes app-created items that haven't reached Google yet.">
                <span>
                    <Button variant="outlined" size="small" onClick={actions.onSyncNow} disabled={isSyncing}>
                        {isSyncing ? <CircularProgress size={14} sx={{ mr: 0.5 }} /> : null}
                        {isSyncing ? 'Syncing…' : 'Sync now'}
                    </Button>
                </span>
            </Tooltip>
            <Tooltip title="Reconnect items and routines that lost their link to Google Calendar — for example after disconnecting and reconnecting an account. Runs for every signed-in account; safe to use any time.">
                <span>
                    <Button variant="outlined" size="small" onClick={actions.onRepair} disabled={isRepairing} data-testid="repairSyncButton">
                        {isRepairing ? <CircularProgress size={14} sx={{ mr: 0.5 }} /> : null}
                        {isRepairing ? 'Repairing…' : 'Repair sync'}
                    </Button>
                </span>
            </Tooltip>
            <Button variant="outlined" size="small" color="error" onClick={actions.onDisconnect}>
                Disconnect
            </Button>
        </Box>
    );
}

/**
 * Builds the option rows for a calendar-picker `<Select>`: grouped (primary → owned → shared) with a
 * non-selectable `<ListSubheader>` before the "Your calendars" / "Shared with you" sections. MUI's
 * Select skips `<ListSubheader>` for value resolution and keyboard nav, so headers don't become options.
 *
 * Returns a flat element ARRAY (not a fragment): MUI Select resolves options via
 * `React.Children.toArray(children)` over its *direct* children and does not recurse into a wrapper
 * component or fragment — so the rows must be spread directly as Select children. A fragment child
 * makes Select see one invalid option and breaks selection/value display entirely.
 */
export function calendarSelectRows(calendars: GoogleCalendar[]) {
    return buildCalendarPickerRows(calendars).map((row) =>
        row.kind === 'header' ? (
            <ListSubheader key={`header-${row.key}`}>{row.label}</ListSubheader>
        ) : (
            <MenuItem key={row.calendar.id} value={row.calendar.id}>
                {row.calendar.name}
                {row.calendar.primary ? ' (primary)' : ''}
            </MenuItem>
        ),
    );
}

interface ConfigActions {
    onToggleEnabled: (config: CalendarSyncConfig) => void;
    onSetDefault: (config: CalendarSyncConfig) => void;
    onRemove: (config: CalendarSyncConfig) => void;
}

interface SyncConfigListProps {
    configs: CalendarSyncConfig[];
    resolveCalendarName: (calendarId: string) => string;
    actions: ConfigActions;
}

function SyncConfigList({ configs, resolveCalendarName, actions }: SyncConfigListProps) {
    if (configs.length === 0) {
        return (
            <Typography
                variant="body2"
                sx={{
                    color: 'text.secondary',
                    fontStyle: 'italic',
                    mt: 1,
                }}
            >
                No calendars synced yet.
            </Typography>
        );
    }

    return (
        <List dense disablePadding sx={{ mt: 0.5 }}>
            {configs.map((config) => {
                // Same expression as the visible ListItemText below, so the switch's accessible name
                // matches the calendar name the user sees (not the raw calendarId when displayName is null).
                const calendarName = config.displayName ?? resolveCalendarName(config.calendarId);
                return (
                    <ListItem
                        key={config._id}
                        disableGutters
                        secondaryAction={
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                {config.isDefault && <Chip label="default" size="small" color="primary" variant="outlined" />}
                                {!config.isDefault && config.enabled && (
                                    <Button size="small" onClick={() => actions.onSetDefault(config)}>
                                        Set default
                                    </Button>
                                )}
                                {/* aria-label on the input slot doubles as the e2e selector (getByRole checkbox,
                                    name: "Sync <calendar>" — MUI's Switch input is type=checkbox) and as
                                    accessible labelling for the otherwise-unlabeled toggle. */}
                                <Switch
                                    size="small"
                                    checked={config.enabled}
                                    onChange={() => actions.onToggleEnabled(config)}
                                    slotProps={{ input: { 'aria-label': `Sync ${calendarName}` } }}
                                />
                                <IconButton size="small" onClick={() => actions.onRemove(config)} title="Stop syncing this calendar">
                                    <Typography variant="body2">✕</Typography>
                                </IconButton>
                            </Box>
                        }
                    >
                        <ListItemText
                            primary={calendarName}
                            slotProps={{
                                primary: { variant: 'body2', color: config.enabled ? 'text.primary' : 'text.disabled' },
                            }}
                        />
                    </ListItem>
                );
            })}
        </List>
    );
}

interface AddCalendarDialogProps {
    integrationId: string;
    availableCalendars: GoogleCalendar[];
    // When this is the integration's first calendar, mark it default so new app-created items have a sync target.
    isFirstCalendar: boolean;
    onClose: () => void;
    onAdded: () => void;
    withActiveAccountSession: WithActiveAccountSession;
}

function AddCalendarDialog({ integrationId, availableCalendars, isFirstCalendar, onClose, onAdded, withActiveAccountSession }: AddCalendarDialogProps) {
    const [selectedId, setSelectedId] = useState(defaultCalendarId(availableCalendars) ?? '');
    const [isSaving, startSaving] = useTransition();
    const [saveError, setSaveError] = useState<string | null>(null);

    function onConfirm() {
        if (!selectedId) {
            return;
        }
        setSaveError(null);
        startSaving(async () => {
            try {
                const displayName = availableCalendars.find((c) => c.id === selectedId)?.name;
                await withActiveAccountSession(() =>
                    createSyncConfig(integrationId, { calendarId: selectedId, isDefault: isFirstCalendar, ...(displayName ? { displayName } : {}) }),
                );
                onAdded();
            } catch (err) {
                console.error('[calendar] add sync config failed:', err);
                setSaveError(formatAddCalendarError(err));
            }
        });
    }

    return (
        <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
            <DialogTitle>Add a calendar to sync</DialogTitle>
            <DialogContent>
                <FormControl size="small" fullWidth sx={{ mt: 1 }}>
                    <InputLabel>Calendar</InputLabel>
                    <Select label="Calendar" value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
                        {calendarSelectRows(availableCalendars)}
                    </Select>
                </FormControl>
            </DialogContent>
            {saveError && (
                <Typography variant="body2" color="error" sx={{ px: 3, pb: 1 }}>
                    {saveError}
                </Typography>
            )}
            <DialogActions>
                <Button onClick={onClose} disabled={isSaving}>
                    Cancel
                </Button>
                <Button onClick={onConfirm} variant="contained" disabled={isSaving || !selectedId}>
                    {isSaving ? 'Adding…' : 'Add'}
                </Button>
            </DialogActions>
        </Dialog>
    );
}

interface ChooseCalendarDialogProps {
    integration: CalendarIntegration;
    onClose: () => void;
    onSaved: () => void;
    /** Called when the save fails with a 404 — the integration id is stale, so the parent re-reads the list. */
    onStaleIntegration: () => void;
    withActiveAccountSession: WithActiveAccountSession;
}

/** Shown after the OAuth callback redirect — lets the user pick an initial calendar to sync. */
function ChooseCalendarDialog({ integration, onClose, onSaved, onStaleIntegration, withActiveAccountSession }: ChooseCalendarDialogProps) {
    const { calendars, isLoading, fetchError: calendarFetchError } = useCalendarList(integration._id);
    const [selectedId, setSelectedId] = useState('');
    const [isSaving, setIsSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const isMountedRef = useRef(true);
    useEffect(
        () => () => {
            isMountedRef.current = false;
        },
        [],
    );

    // Default to the primary calendar (else the first in picker order) once the list loads.
    useEffect(() => {
        const defaultId = defaultCalendarId(calendars);
        if (defaultId && !selectedId) {
            setSelectedId(defaultId);
        }
    }, [calendars, selectedId]);

    async function onConfirm() {
        if (!selectedId) {
            return;
        }
        setIsSaving(true);
        setSaveError(null);
        try {
            const displayName = calendars.find((c) => c.id === selectedId)?.name;
            // First calendar added via the post-OAuth dialog becomes the default sync target.
            await withActiveAccountSession(() =>
                createSyncConfig(integration._id, { calendarId: selectedId, isDefault: true, ...(displayName ? { displayName } : {}) }),
            );
            onSaved();
        } catch (err) {
            console.error('[calendar] save initial sync config failed:', err);
            // A 404 means this dialog's integration id is stale (disconnect/reconnect race). Re-read the
            // list so the row reflects the live integration before the user retries.
            if (isStaleIntegrationError(err)) {
                onStaleIntegration();
            }
            if (isMountedRef.current) {
                setSaveError(formatSaveCalendarError(err));
            }
        } finally {
            if (isMountedRef.current) setIsSaving(false);
        }
    }

    return (
        <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
            <DialogTitle>Choose a calendar to sync</DialogTitle>
            <DialogContent>
                <DialogContentText
                    sx={{
                        mb: 2,
                    }}
                >
                    Select which Google Calendar events should appear in this app.
                </DialogContentText>
                {isLoading ? (
                    <CircularProgress size={20} />
                ) : calendarFetchError ? (
                    <Typography variant="body2" color="error">
                        {calendarFetchError}
                    </Typography>
                ) : (
                    <FormControl size="small" fullWidth>
                        <InputLabel>Calendar</InputLabel>
                        <Select label="Calendar" value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
                            {calendarSelectRows(calendars)}
                        </Select>
                    </FormControl>
                )}
            </DialogContent>
            {saveError && (
                <Typography variant="body2" color="error" sx={{ px: 3, pb: 1 }}>
                    {saveError}
                </Typography>
            )}
            <DialogActions>
                {/* No "Skip" button: Step 2 makes calendar choice mandatory. The integration row
                    surfaces a "No calendar selected — choose one" CTA if the user dismisses the
                    dialog by clicking outside. */}
                <Button onClick={onConfirm} variant="contained" disabled={isSaving || isLoading || !selectedId}>
                    {isSaving ? 'Saving…' : 'Save & sync'}
                </Button>
            </DialogActions>
        </Dialog>
    );
}

interface DisconnectDialogProps {
    open: boolean;
    integrationId: string;
    onClose: () => void;
    onDisconnected: () => void;
    withActiveAccountSession: WithActiveAccountSession;
}

function DisconnectDialog({ open, integrationId, onClose, onDisconnected, withActiveAccountSession }: DisconnectDialogProps) {
    const [action, setAction] = useState<UnlinkAction>('keepLinkedEntities');
    const [isDeleting, startDeleting] = useTransition();
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const { syncAndRefresh } = useAppData();
    const isMountedRef = useRef(true);
    useEffect(
        () => () => {
            isMountedRef.current = false;
        },
        [],
    );

    // Reset transient state each time the dialog opens so a previous failed attempt
    // doesn't bleed into a fresh disconnect attempt for a different integration.
    useEffect(() => {
        if (open) {
            setAction('keepLinkedEntities');
            setDeleteError(null);
        }
    }, [open]);

    function onConfirm() {
        setDeleteError(null);
        startDeleting(async () => {
            try {
                await withActiveAccountSession(() => deleteIntegration(integrationId, action));
                onDisconnected();
                onClose();
                // Sync IDB so calendar items removed server-side are reflected locally immediately.
                syncAndRefresh().catch(() => {});
            } catch {
                // isMountedRef guards the error setter — useTransition discards isPending writes
                // automatically on unmount, so it doesn't need its own guard.
                if (isMountedRef.current) setDeleteError('Failed to disconnect. Please try again.');
            }
        });
    }

    return (
        <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
            <DialogTitle>Disconnect Google Calendar</DialogTitle>
            <DialogContent>
                <DialogContentText
                    sx={{
                        mb: 2,
                    }}
                >
                    What would you like to do with calendar items and calendar routines linked to this integration? Disconnecting never modifies your Google
                    Calendar.
                </DialogContentText>
                <RadioGroup value={action} onChange={(e) => setAction(e.target.value as UnlinkAction)}>
                    <FormControlLabel
                        value="keepLinkedEntities"
                        control={<Radio size="small" />}
                        label={
                            <Box>
                                <Typography variant="body2">
                                    Keep calendar items and calendar routines in GTD. Google Calendar events will not be touched.
                                </Typography>
                            </Box>
                        }
                    />
                    <FormControlLabel
                        value="removeLinkedEntities"
                        control={<Radio size="small" />}
                        label={
                            <Box>
                                <Typography
                                    variant="body2"
                                    sx={{
                                        color: 'error.main',
                                    }}
                                >
                                    Remove calendar items and calendar routines from GTD. Google Calendar events will not be touched.
                                </Typography>
                            </Box>
                        }
                    />
                </RadioGroup>
            </DialogContent>
            {deleteError && (
                <Typography variant="body2" color="error" sx={{ px: 3, pb: 1 }}>
                    {deleteError}
                </Typography>
            )}
            <DialogActions>
                <Button onClick={onClose} disabled={isDeleting}>
                    Cancel
                </Button>
                <Button onClick={onConfirm} color="error" disabled={isDeleting}>
                    {isDeleting ? 'Disconnecting…' : 'Disconnect'}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
