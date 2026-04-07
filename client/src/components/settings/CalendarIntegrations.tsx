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
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Select from '@mui/material/Select';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import { useNavigate, useSearch } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    type CalendarIntegration,
    type CalendarSyncConfig,
    createSyncConfig,
    deleteIntegration,
    deleteSyncConfig,
    type GoogleCalendar,
    initiateGoogleCalendarAuth,
    listCalendars,
    listIntegrations,
    listSyncConfigs,
    syncIntegration,
    type UnlinkAction,
    updateSyncConfig,
} from '../../api/calendarApi';
import { useAppData } from '../../contexts/AppDataProvider';
import { hasAtLeastOne } from '../../lib/typeUtils';

/** Fetches the calendar list for an integration, with unmount-safe cancellation. */
function useCalendarList(integrationId: string): { calendars: GoogleCalendar[]; isLoading: boolean; fetchError: string | null } {
    const [calendars, setCalendars] = useState<GoogleCalendar[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [fetchError, setFetchError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        listCalendars(integrationId)
            .then((cals) => {
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
    const [integrations, setIntegrations] = useState<CalendarIntegration[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [chooseCalendarFor, setChooseCalendarFor] = useState<CalendarIntegration | null>(null);
    const { syncAndRefresh } = useAppData();
    const navigate = useNavigate();
    // calendarConnected is set by the OAuth callback redirect so we can auto-open the picker.
    const { calendarConnected } = useSearch({ from: '/_authenticated/settings' });
    // isMountedRef guards setState calls in loadIntegrations against post-unmount updates.
    const isMountedRef = useRef(true);

    const loadIntegrations = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const loaded = await listIntegrations();
            if (!isMountedRef.current) {
                return [];
            }
            setIntegrations(loaded);
            return loaded;
        } catch {
            if (!isMountedRef.current) {
                return [];
            }
            setError('Failed to load calendar integrations.');
            return [];
        } finally {
            // isMountedRef guards setState against post-unmount updates. A fast dep change
            // could cause two overlapping calls; the stale call's finally fires while the new
            // call is in flight. isMountedRef is reset to true at effect start (see below), so
            // it cannot distinguish the stale call — the stale call may clear isLoading early.
            // Accepting this: the race window is tiny and the worst case is a brief spinner gap.
            if (isMountedRef.current) setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        // Reset on every re-run: cleanup sets this to false, so without the reset
        // loadIntegrations() would bail immediately when the effect re-fires (e.g. after
        // navigate clears calendarConnected).
        isMountedRef.current = true;
        // cancelled guards THIS invocation's .then() callback — isMountedRef is reset to true
        // at re-run start, so it cannot distinguish a stale .then() from a fresh one.
        let cancelled = false;
        loadIntegrations().then((loaded) => {
            if (cancelled || !calendarConnected || !hasAtLeastOne(loaded)) {
                return;
            }
            // Auto-open the calendar picker for the most recently connected integration and
            // clear the query param so a reload doesn't reopen it.
            const newest = loaded.reduce((a, b) => (a.createdTs > b.createdTs ? a : b));
            setChooseCalendarFor(newest);
            navigate({ to: '/settings', search: { calendarConnected: undefined }, replace: true }).catch(() => {});
        });
        return () => {
            cancelled = true;
            // Prevent setState calls in loadIntegrations from firing after unmount.
            isMountedRef.current = false;
        };
    }, [calendarConnected, loadIntegrations, navigate]);

    if (isLoading) {
        return <CircularProgress size={20} />;
    }

    if (error) {
        return (
            <Typography variant="body2" color="error">
                {error}
            </Typography>
        );
    }

    return (
        <Box>
            {integrations.length === 0 && (
                <Typography variant="body2" color="text.secondary" fontStyle="italic" mb={2}>
                    No calendars connected.
                </Typography>
            )}
            {integrations.map((integration) => (
                <IntegrationRow key={integration._id} integration={integration} onDisconnected={loadIntegrations} />
            ))}
            <Button variant="outlined" size="small" onClick={initiateGoogleCalendarAuth}>
                Connect Google Calendar
            </Button>

            {chooseCalendarFor && (
                <ChooseCalendarDialog
                    integration={chooseCalendarFor}
                    onClose={() => setChooseCalendarFor(null)}
                    onSaved={() => {
                        setChooseCalendarFor(null);
                        syncAndRefresh().catch(() => {});
                    }}
                />
            )}
        </Box>
    );
}

/** Fetches sync configs for an integration, with unmount-safe cancellation. */
function useSyncConfigs(integrationId: string): {
    configs: CalendarSyncConfig[];
    isLoading: boolean;
    reload: () => void;
    setConfigs: React.Dispatch<React.SetStateAction<CalendarSyncConfig[]>>;
} {
    const [configs, setConfigs] = useState<CalendarSyncConfig[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const isMountedRef = useRef(true);

    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    const fetchConfigs = useCallback(async () => {
        setIsLoading(true);
        try {
            const loaded = await listSyncConfigs(integrationId);
            if (isMountedRef.current) setConfigs(loaded);
        } catch {
            // Swallow — the caller decides how to handle missing configs.
        } finally {
            if (isMountedRef.current) setIsLoading(false);
        }
    }, [integrationId]);

    useEffect(() => {
        fetchConfigs();
    }, [fetchConfigs]);

    return { configs, isLoading, reload: fetchConfigs, setConfigs };
}

interface IntegrationRowProps {
    integration: CalendarIntegration;
    onDisconnected: () => void;
}

/** Manages sync config mutations with error handling and optimistic state updates. */
function useSyncConfigActions(
    integrationId: string,
    setConfigs: React.Dispatch<React.SetStateAction<CalendarSyncConfig[]>>,
): { actions: ConfigActions; actionError: string | null } {
    const [actionError, setActionError] = useState<string | null>(null);

    const onToggleEnabled = useCallback(
        async (config: CalendarSyncConfig) => {
            setActionError(null);
            try {
                const updated = await updateSyncConfig(integrationId, config._id, { enabled: !config.enabled });
                setConfigs((prev) => prev.map((c) => (c._id === config._id ? updated : c)));
            } catch {
                setActionError('Failed to update calendar. Please try again.');
            }
        },
        [integrationId, setConfigs],
    );

    const onSetDefault = useCallback(
        async (config: CalendarSyncConfig) => {
            setActionError(null);
            try {
                const updated = await updateSyncConfig(integrationId, config._id, { isDefault: true });
                // The server unsets isDefault on all sibling configs — refresh to get accurate state.
                setConfigs((prev) => prev.map((c) => (c._id === config._id ? updated : { ...c, isDefault: false })));
            } catch {
                setActionError('Failed to set default calendar. Please try again.');
            }
        },
        [integrationId, setConfigs],
    );

    const onRemove = useCallback(
        async (config: CalendarSyncConfig) => {
            setActionError(null);
            try {
                await deleteSyncConfig(integrationId, config._id);
                setConfigs((prev) => prev.filter((c) => c._id !== config._id));
            } catch {
                setActionError('Failed to remove calendar. Please try again.');
            }
        },
        [integrationId, setConfigs],
    );

    return { actions: { onToggleEnabled, onSetDefault, onRemove }, actionError };
}

/** Wraps the sync-now action with loading, error, and unmount-safety state. */
function useSyncNow(integrationId: string): { onSyncNow: () => void; isSyncing: boolean; syncError: string | null } {
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
            await syncIntegration(integrationId);
            await syncAndRefresh();
        } catch {
            if (isMountedRef.current) setSyncError('Sync failed. Please try again.');
        } finally {
            if (isMountedRef.current) setIsSyncing(false);
        }
    }, [integrationId, syncAndRefresh]);

    return { onSyncNow, isSyncing, syncError };
}

function IntegrationRow({ integration, onDisconnected }: IntegrationRowProps) {
    const { calendars, fetchError: calendarFetchError } = useCalendarList(integration._id);
    const { configs, isLoading: configsLoading, reload: reloadConfigs, setConfigs } = useSyncConfigs(integration._id);
    const { actions, actionError } = useSyncConfigActions(integration._id, setConfigs);
    const { onSyncNow, isSyncing, syncError } = useSyncNow(integration._id);
    const [isDisconnectOpen, setIsDisconnectOpen] = useState(false);
    const [isAddCalendarOpen, setIsAddCalendarOpen] = useState(false);
    const { syncAndRefresh } = useAppData();

    function resolveCalendarName(calendarId: string): string {
        return calendars.find((c) => c.id === calendarId)?.name ?? calendarId;
    }

    // Calendars already being synced — used to filter the "add calendar" dropdown.
    const syncedCalendarIds = new Set(configs.map((c) => c.calendarId));
    const availableToAdd = calendars.filter((c) => !syncedCalendarIds.has(c.id));

    const connectedSince = dayjs(integration.createdTs).format('MMM D, YYYY');
    const errorMessage = calendarFetchError ?? actionError ?? syncError;

    return (
        <Box mb={2}>
            <Divider sx={{ mb: 1.5 }} />
            <Typography variant="body2" fontWeight={600} mb={0.5}>
                Google Calendar
            </Typography>
            <Typography variant="caption" color="text.secondary" display="block">
                Connected {connectedSince}
            </Typography>

            {errorMessage && (
                <Typography variant="caption" color="error" display="block" mt={1}>
                    {errorMessage}
                </Typography>
            )}

            {configsLoading ? (
                <CircularProgress size={16} sx={{ mt: 1 }} />
            ) : (
                <SyncConfigList configs={configs} resolveCalendarName={resolveCalendarName} actions={actions} />
            )}

            <IntegrationActions
                isSyncing={isSyncing}
                hasAvailableCalendars={availableToAdd.length > 0}
                actions={{ onSyncNow, onAddCalendar: () => setIsAddCalendarOpen(true), onDisconnect: () => setIsDisconnectOpen(true) }}
            />

            <DisconnectDialog
                open={isDisconnectOpen}
                integrationId={integration._id}
                onClose={() => setIsDisconnectOpen(false)}
                onDisconnected={onDisconnected}
            />

            {isAddCalendarOpen && (
                <AddCalendarDialog
                    integrationId={integration._id}
                    availableCalendars={availableToAdd}
                    onClose={() => setIsAddCalendarOpen(false)}
                    onAdded={() => {
                        setIsAddCalendarOpen(false);
                        reloadConfigs();
                        syncAndRefresh().catch(() => {});
                    }}
                />
            )}
        </Box>
    );
}

interface IntegrationRowActions {
    onSyncNow: () => void;
    onAddCalendar: () => void;
    onDisconnect: () => void;
}

interface IntegrationActionsProps {
    isSyncing: boolean;
    hasAvailableCalendars: boolean;
    actions: IntegrationRowActions;
}

function IntegrationActions({ isSyncing, hasAvailableCalendars, actions }: IntegrationActionsProps) {
    return (
        <Box sx={{ display: 'flex', gap: 1, mt: 1.5 }}>
            {hasAvailableCalendars && (
                <Button variant="outlined" size="small" onClick={actions.onAddCalendar}>
                    Add calendar
                </Button>
            )}
            <Button variant="outlined" size="small" onClick={actions.onSyncNow} disabled={isSyncing}>
                {isSyncing ? <CircularProgress size={14} sx={{ mr: 0.5 }} /> : null}
                {isSyncing ? 'Syncing…' : 'Sync now'}
            </Button>
            <Button variant="outlined" size="small" color="error" onClick={actions.onDisconnect}>
                Disconnect
            </Button>
        </Box>
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
            <Typography variant="body2" color="text.secondary" fontStyle="italic" mt={1}>
                No calendars synced yet.
            </Typography>
        );
    }

    return (
        <List dense disablePadding sx={{ mt: 0.5 }}>
            {configs.map((config) => (
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
                            <Switch size="small" checked={config.enabled} onChange={() => actions.onToggleEnabled(config)} />
                            <IconButton size="small" onClick={() => actions.onRemove(config)} title="Stop syncing this calendar">
                                <Typography variant="body2">✕</Typography>
                            </IconButton>
                        </Box>
                    }
                >
                    <ListItemText
                        primary={config.displayName ?? resolveCalendarName(config.calendarId)}
                        primaryTypographyProps={{ variant: 'body2', color: config.enabled ? 'text.primary' : 'text.disabled' }}
                    />
                </ListItem>
            ))}
        </List>
    );
}

interface AddCalendarDialogProps {
    integrationId: string;
    availableCalendars: GoogleCalendar[];
    onClose: () => void;
    onAdded: () => void;
}

function AddCalendarDialog({ integrationId, availableCalendars, onClose, onAdded }: AddCalendarDialogProps) {
    const [selectedId, setSelectedId] = useState(hasAtLeastOne(availableCalendars) ? availableCalendars[0].id : '');
    const [isSaving, setIsSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);

    async function onConfirm() {
        if (!selectedId) {
            return;
        }
        setIsSaving(true);
        setSaveError(null);
        try {
            const displayName = availableCalendars.find((c) => c.id === selectedId)?.name;
            await createSyncConfig(integrationId, { calendarId: selectedId, ...(displayName ? { displayName } : {}) });
            onAdded();
        } catch {
            setSaveError('Failed to add calendar. Please try again.');
            setIsSaving(false);
        }
    }

    return (
        <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
            <DialogTitle>Add a calendar to sync</DialogTitle>
            <DialogContent>
                <FormControl size="small" fullWidth sx={{ mt: 1 }}>
                    <InputLabel>Calendar</InputLabel>
                    <Select label="Calendar" value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
                        {availableCalendars.map((cal) => (
                            <MenuItem key={cal.id} value={cal.id}>
                                {cal.name}
                            </MenuItem>
                        ))}
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
}

/** Shown after the OAuth callback redirect — lets the user pick an initial calendar to sync. */
function ChooseCalendarDialog({ integration, onClose, onSaved }: ChooseCalendarDialogProps) {
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

    // Default to the first calendar once the list loads.
    useEffect(() => {
        if (hasAtLeastOne(calendars) && !selectedId) {
            setSelectedId(calendars[0].id);
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
            await createSyncConfig(integration._id, { calendarId: selectedId, isDefault: true, ...(displayName ? { displayName } : {}) });
            onSaved();
        } catch {
            if (isMountedRef.current) {
                setSaveError('Failed to save calendar selection. Please try again.');
            }
        } finally {
            if (isMountedRef.current) setIsSaving(false);
        }
    }

    return (
        <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
            <DialogTitle>Choose a calendar to sync</DialogTitle>
            <DialogContent>
                <DialogContentText mb={2}>Select which Google Calendar events should appear in this app.</DialogContentText>
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
                            {calendars.map((cal) => (
                                <MenuItem key={cal.id} value={cal.id}>
                                    {cal.name}
                                </MenuItem>
                            ))}
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
                <Button onClick={onClose} disabled={isSaving}>
                    Skip
                </Button>
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
}

function DisconnectDialog({ open, integrationId, onClose, onDisconnected }: DisconnectDialogProps) {
    const [action, setAction] = useState<UnlinkAction>('keepEvents');
    const [isDeleting, setIsDeleting] = useState(false);
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
            setAction('keepEvents');
            setDeleteError(null);
        }
    }, [open]);

    async function onConfirm() {
        setIsDeleting(true);
        setDeleteError(null);
        try {
            await deleteIntegration(integrationId, action);
            onDisconnected();
            onClose();
            // Sync IDB so calendar items removed server-side are reflected locally immediately.
            syncAndRefresh().catch(() => {});
        } catch {
            if (isMountedRef.current) setDeleteError('Failed to disconnect. Please try again.');
        } finally {
            if (isMountedRef.current) setIsDeleting(false);
        }
    }

    return (
        <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
            <DialogTitle>Disconnect Google Calendar</DialogTitle>
            <DialogContent>
                <DialogContentText mb={2}>What would you like to do with routines currently synced to this Google Calendar?</DialogContentText>
                <RadioGroup value={action} onChange={(e) => setAction(e.target.value as UnlinkAction)}>
                    <FormControlLabel
                        value="keepEvents"
                        control={<Radio size="small" />}
                        label={
                            <Box>
                                <Typography variant="body2">Keep routines in GTD, leave Google Calendar events as-is</Typography>
                            </Box>
                        }
                    />
                    <FormControlLabel
                        value="deleteEvents"
                        control={<Radio size="small" />}
                        label={
                            <Box>
                                <Typography variant="body2">Keep routines in GTD, remove them from Google Calendar</Typography>
                            </Box>
                        }
                    />
                    <FormControlLabel
                        value="deleteAll"
                        control={<Radio size="small" />}
                        label={
                            <Box>
                                <Typography variant="body2" color="error.main">
                                    Delete routines from both GTD and Google Calendar
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
