import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Select from '@mui/material/Select';
import Typography from '@mui/material/Typography';
import { useNavigate, useSearch } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    type CalendarIntegration,
    deleteIntegration,
    type GoogleCalendar,
    initiateGoogleCalendarAuth,
    listCalendars,
    listIntegrations,
    syncIntegration,
    type UnlinkAction,
    updateIntegration,
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
                <IntegrationRow
                    key={integration._id}
                    integration={integration}
                    onDisconnected={loadIntegrations}
                    onCalendarChanged={(updated) => setIntegrations((prev) => prev.map((i) => (i._id === updated._id ? updated : i)))}
                />
            ))}
            <Button variant="outlined" size="small" onClick={initiateGoogleCalendarAuth}>
                Connect Google Calendar
            </Button>

            {chooseCalendarFor && (
                <ChooseCalendarDialog
                    integration={chooseCalendarFor}
                    onClose={() => setChooseCalendarFor(null)}
                    onSaved={(calendarId) => {
                        setIntegrations((prev) => prev.map((i) => (i._id === chooseCalendarFor._id ? { ...i, calendarId } : i)));
                        setChooseCalendarFor(null);
                        syncAndRefresh().catch(() => {});
                    }}
                />
            )}
        </Box>
    );
}

interface IntegrationRowProps {
    integration: CalendarIntegration;
    onDisconnected: () => void;
    onCalendarChanged: (updated: CalendarIntegration) => void;
}

function IntegrationRow({ integration, onDisconnected, onCalendarChanged }: IntegrationRowProps) {
    const { calendars, fetchError: calendarFetchError } = useCalendarList(integration._id);
    const [isSyncing, setIsSyncing] = useState(false);
    const [isDisconnectOpen, setIsDisconnectOpen] = useState(false);
    const { syncAndRefresh } = useAppData();
    // Guards onCalendarSelect / onSyncNow against setState calls after the row unmounts
    // (e.g. user disconnects while a sync is in flight).
    const isMountedRef = useRef(true);
    useEffect(
        () => () => {
            isMountedRef.current = false;
        },
        [],
    );

    async function onCalendarSelect(calendarId: string) {
        await updateIntegration(integration._id, calendarId);
        if (!isMountedRef.current) {
            return;
        }
        onCalendarChanged({ ...integration, calendarId });
        // Fire-and-forget: a sync failure must not roll back a successful calendar save.
        syncAndRefresh().catch(() => {});
    }

    async function onSyncNow() {
        setIsSyncing(true);
        try {
            await syncIntegration(integration._id);
            await syncAndRefresh();
        } finally {
            if (isMountedRef.current) setIsSyncing(false);
        }
    }

    const connectedSince = dayjs(integration.createdTs).format('MMM D, YYYY');
    const lastSynced = integration.lastSyncedTs ? dayjs(integration.lastSyncedTs).format('MMM D, YYYY h:mm A') : 'Never';

    return (
        <Box mb={2}>
            <Divider sx={{ mb: 1.5 }} />
            <Typography variant="body2" fontWeight={600} mb={0.5}>
                Google Calendar
            </Typography>
            <Typography variant="caption" color="text.secondary" display="block">
                Connected {connectedSince} · Last synced {lastSynced}
            </Typography>

            {calendarFetchError && (
                <Typography variant="caption" color="error" display="block" mt={1}>
                    {calendarFetchError}
                </Typography>
            )}
            {calendars.length > 0 && (
                <Box mt={1} mb={1}>
                    <FormControl size="small">
                        <InputLabel>Syncing to</InputLabel>
                        <Select
                            label="Syncing to"
                            value={integration.calendarId}
                            onChange={(e) =>
                                onCalendarSelect(e.target.value).catch(() => {
                                    // Roll back the optimistic UI update so the select doesn't
                                    // show a calendar that wasn't actually saved.
                                    onCalendarChanged(integration);
                                })
                            }
                            sx={{ minWidth: 200 }}
                        >
                            {calendars.map((cal) => (
                                <MenuItem key={cal.id} value={cal.id}>
                                    {cal.name}
                                </MenuItem>
                            ))}
                            {!calendars.some((c) => c.id === integration.calendarId) && (
                                <MenuItem value={integration.calendarId}>{integration.calendarId}</MenuItem>
                            )}
                        </Select>
                    </FormControl>
                </Box>
            )}

            <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
                <Button variant="outlined" size="small" onClick={onSyncNow} disabled={isSyncing}>
                    {isSyncing ? <CircularProgress size={14} sx={{ mr: 0.5 }} /> : null}
                    {isSyncing ? 'Syncing…' : 'Sync now'}
                </Button>
                <Button variant="outlined" size="small" color="error" onClick={() => setIsDisconnectOpen(true)}>
                    Disconnect
                </Button>
            </Box>

            <DisconnectDialog
                open={isDisconnectOpen}
                integrationId={integration._id}
                onClose={() => setIsDisconnectOpen(false)}
                onDisconnected={onDisconnected}
            />
        </Box>
    );
}

/** Returns the calendar ID to show selected in the picker.
 *  Prefers the user's explicit choice; falls back to the first real calendar when
 *  integration.calendarId is an alias ('primary') that doesn't appear in calendarList. */
export function resolveSelectedCalendarId(userSelectedId: string | null, calendars: GoogleCalendar[], integrationCalendarId: string): string {
    if (userSelectedId !== null) {
        return userSelectedId;
    }
    const isKnown = calendars.some((c) => c.id === integrationCalendarId);
    return isKnown ? integrationCalendarId : hasAtLeastOne(calendars) ? calendars[0].id : integrationCalendarId;
}

interface ChooseCalendarDialogProps {
    integration: CalendarIntegration;
    onClose: () => void;
    onSaved: (calendarId: string) => void;
}

function ChooseCalendarDialog({ integration, onClose, onSaved }: ChooseCalendarDialogProps) {
    const { calendars, isLoading, fetchError: calendarFetchError } = useCalendarList(integration._id);
    // null = no user override yet; the resolved selectedId defaults below.
    const [userSelectedId, setUserSelectedId] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    // Guards onConfirm against setState calls if the dialog unmounts while the save is in flight
    // (e.g. parent closes it after a concurrent update).
    const isMountedRef = useRef(true);
    useEffect(
        () => () => {
            isMountedRef.current = false;
        },
        [],
    );

    // 'primary' is a GCal alias that doesn't appear by name in calendarList, so default to the
    // first real calendar once the list loads. User's manual choice (userSelectedId) takes priority.
    const selectedId = resolveSelectedCalendarId(userSelectedId, calendars, integration.calendarId);

    async function onConfirm() {
        setIsSaving(true);
        setSaveError(null);
        try {
            await updateIntegration(integration._id, selectedId);
            onSaved(selectedId);
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
                        <Select label="Calendar" value={selectedId} onChange={(e) => setUserSelectedId(e.target.value)}>
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
                <Button onClick={onConfirm} variant="contained" disabled={isSaving || isLoading}>
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
