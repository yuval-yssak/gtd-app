import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import type { IDBPDatabase } from 'idb';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ConnectedDevice, listConnectedDevices, removeDevice, renameDevice } from '../../api/devicesApi';
import { getOrCreateDeviceId } from '../../db/deviceId';
import type { MyDB } from '../../types/MyDB';
import styles from './ConnectedDevices.module.css';

dayjs.extend(relativeTime);

// ── Pure display helpers (exported for unit tests) ───────────────────────────

export function deviceDisplayName(device: Pick<ConnectedDevice, 'name' | 'autoLabel'>): string {
    return device.name ?? device.autoLabel ?? 'Unknown device';
}

/** "Last seen 3 days ago · 42 operations behind" — the row's secondary line. */
export function describeDeviceActivity(device: Pick<ConnectedDevice, 'lastSeenTs' | 'opsBehind'>, now: dayjs.Dayjs = dayjs()): string {
    const lastSeen = `Last seen ${now.to(dayjs(device.lastSeenTs))}`;
    const lag = device.opsBehind === 0 ? 'up to date' : `${device.opsBehind} operation${device.opsBehind === 1 ? '' : 's'} behind`;
    return `${lastSeen} · ${lag}`;
}

/**
 * Only flag the floor holder when it is actually costing something: every account always has SOME
 * slowest device, but a fully-caught-up floor holder isn't blocking any cleanup.
 */
export function isHoldingBackCleanup(device: Pick<ConnectedDevice, 'holdsPurgeFloor' | 'opsBehind'>): boolean {
    return device.holdsPurgeFloor && device.opsBehind > 0;
}

/** Current device first (it's the reference point), then most recently seen first. */
export function sortDevicesForDisplay(devices: ConnectedDevice[], currentDeviceId: string | null): ConnectedDevice[] {
    return [...devices].sort((a, b) => {
        if (a.deviceId === currentDeviceId) return -1;
        if (b.deviceId === currentDeviceId) return 1;
        return b.lastSeenTs.localeCompare(a.lastSeenTs);
    });
}

// ── Component ─────────────────────────────────────────────────────────────────

type RemoveState = { phase: 'closed' } | { phase: 'confirm'; device: ConnectedDevice };
type RenameState = { phase: 'closed' } | { phase: 'open'; device: ConnectedDevice };

export function ConnectedDevices({ db }: { db: IDBPDatabase<MyDB> }) {
    const [devices, setDevices] = useState<ConnectedDevice[]>([]);
    const [totalOps, setTotalOps] = useState(0);
    const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [removeState, setRemoveState] = useState<RemoveState>({ phase: 'closed' });
    const [renameState, setRenameState] = useState<RenameState>({ phase: 'closed' });
    const [removingId, setRemovingId] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [freedSummary, setFreedSummary] = useState<string | null>(null);
    // isMountedRef guards setState calls in refresh against post-unmount updates,
    // mirroring the pattern in PersonalApiTokens / CalendarIntegrations.
    const isMountedRef = useRef(true);

    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    const refresh = useCallback(async () => {
        setLoadError(null);
        try {
            const [payload, deviceId] = await Promise.all([listConnectedDevices(), getOrCreateDeviceId(db)]);
            if (isMountedRef.current) {
                setDevices(payload.devices);
                setTotalOps(payload.totalOps);
                setCurrentDeviceId(deviceId);
            }
        } catch (err) {
            if (isMountedRef.current) {
                setLoadError(err instanceof Error ? err.message : 'Failed to load devices.');
            }
        } finally {
            if (isMountedRef.current) {
                setIsLoading(false);
            }
        }
    }, [db]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    function openRemove(device: ConnectedDevice) {
        setActionError(null);
        setFreedSummary(null);
        setRemoveState({ phase: 'confirm', device });
    }

    async function onRemoveConfirm() {
        if (removeState.phase !== 'confirm') {
            return;
        }
        const { deviceId } = removeState.device;
        setRemovingId(deviceId);
        try {
            const { purgedOps } = await removeDevice(deviceId);
            setRemoveState({ phase: 'closed' });
            setFreedSummary(purgedOps > 0 ? `Device removed — ${purgedOps} operations of sync history freed.` : 'Device removed.');
            await refresh();
        } catch (err) {
            // Close the dialog on failure too — the section-level error line would otherwise sit
            // invisible behind the modal.
            setRemoveState({ phase: 'closed' });
            setActionError(err instanceof Error ? err.message : 'Failed to remove device.');
        } finally {
            setRemovingId(null);
        }
    }

    function openRename(device: ConnectedDevice) {
        setActionError(null);
        setFreedSummary(null);
        setRenameState({ phase: 'open', device });
    }

    async function onRenameSubmit(name: string) {
        if (renameState.phase !== 'open') {
            return;
        }
        try {
            await renameDevice(renameState.device.deviceId, name);
            setRenameState({ phase: 'closed' });
            await refresh();
        } catch (err) {
            // Same as removal: dismiss the modal so the error line is actually visible.
            setRenameState({ phase: 'closed' });
            setActionError(err instanceof Error ? err.message : 'Failed to rename device.');
        }
    }

    if (isLoading) {
        return (
            <Typography variant="body2" className={styles.loadingState}>
                Loading devices…
            </Typography>
        );
    }
    if (loadError) {
        return (
            <Typography variant="body2" className={styles.loadError} data-testid="devicesLoadError">
                {loadError}
            </Typography>
        );
    }
    return (
        <Box>
            <DeviceList devices={devices} currentDeviceId={currentDeviceId} removingId={removingId} onRemove={openRemove} onRename={openRename} />
            {freedSummary && (
                <Typography variant="body2" className={styles.freedSummary} data-testid="deviceRemovedSummary">
                    {freedSummary}
                </Typography>
            )}
            {actionError && (
                <Typography variant="body2" className={styles.actionError} data-testid="devicesActionError">
                    {actionError}
                </Typography>
            )}
            <Typography variant="caption" className={styles.opsSummary} data-testid="opsLogSummary">
                Sync history: {totalOps} operation{totalOps === 1 ? '' : 's'} retained. History older than what every connected device has received is cleaned
                up automatically.
            </Typography>
            <RemoveDeviceDialog
                state={removeState}
                onCancel={() => setRemoveState({ phase: 'closed' })}
                onConfirm={() => void onRemoveConfirm()}
                isRemoving={removingId !== null}
            />
            {/* key + conditional render: a fresh mount per (open, device) seeds the name field via
                useState's initializer — no reset effect needed, and reopening for a different
                device can never show the previous device's draft. */}
            {renameState.phase === 'open' && (
                <RenameDeviceDialog
                    key={renameState.device.deviceId}
                    device={renameState.device}
                    onCancel={() => setRenameState({ phase: 'closed' })}
                    onSubmit={(name) => void onRenameSubmit(name)}
                />
            )}
        </Box>
    );
}

interface DeviceListProps {
    devices: ConnectedDevice[];
    currentDeviceId: string | null;
    removingId: string | null;
    onRemove: (device: ConnectedDevice) => void;
    onRename: (device: ConnectedDevice) => void;
}

function DeviceList({ devices, currentDeviceId, removingId, onRemove, onRename }: DeviceListProps) {
    if (devices.length === 0) {
        // Only reachable before this device's first bootstrap completes (the bootstrap itself
        // registers a row) — but render something sensible rather than an empty gap.
        return (
            <Typography variant="body2" sx={{ color: 'text.secondary' }} data-testid="devicesEmptyState">
                No devices are registered for sync yet.
            </Typography>
        );
    }
    return (
        <List dense disablePadding data-testid="deviceList">
            {sortDevicesForDisplay(devices, currentDeviceId).map((device) => (
                <DeviceRow
                    key={device.deviceId}
                    device={device}
                    isCurrentDevice={device.deviceId === currentDeviceId}
                    isRemoving={removingId === device.deviceId}
                    onRemove={onRemove}
                    onRename={onRename}
                />
            ))}
        </List>
    );
}

interface DeviceRowProps {
    device: ConnectedDevice;
    isCurrentDevice: boolean;
    isRemoving: boolean;
    onRemove: (device: ConnectedDevice) => void;
    onRename: (device: ConnectedDevice) => void;
}

function DeviceRow({ device, isCurrentDevice, isRemoving, onRemove, onRename }: DeviceRowProps) {
    return (
        <ListItem
            disableGutters
            data-testid="deviceRow"
            secondaryAction={
                <Box className={styles.rowActions}>
                    <Button size="small" onClick={() => onRename(device)} data-testid="renameDeviceButton">
                        Rename
                    </Button>
                    {/* No Remove for the device you're on: removing it would only force this very
                        browser through a full re-download on its next sync — never what's meant here. */}
                    {!isCurrentDevice && (
                        <Button size="small" color="warning" onClick={() => onRemove(device)} disabled={isRemoving} data-testid="removeDeviceButton">
                            {isRemoving ? 'Removing…' : 'Remove'}
                        </Button>
                    )}
                </Box>
            }
        >
            <ListItemText
                primary={
                    <Box className={styles.primaryLine}>
                        <Box component="span">{deviceDisplayName(device)}</Box>
                        {isCurrentDevice && <Chip size="small" color="primary" variant="outlined" label="This device" data-testid="thisDeviceChip" />}
                        {isHoldingBackCleanup(device) && (
                            <Chip size="small" color="warning" variant="outlined" label="Holding back cleanup" data-testid="holdingCleanupChip" />
                        )}
                    </Box>
                }
                secondary={describeDeviceActivity(device)}
            />
        </ListItem>
    );
}

interface RemoveDeviceDialogProps {
    state: RemoveState;
    onCancel: () => void;
    onConfirm: () => void;
    isRemoving: boolean;
}

function RemoveDeviceDialog({ state, onCancel, onConfirm, isRemoving }: RemoveDeviceDialogProps) {
    if (state.phase === 'closed') {
        return null;
    }
    return (
        <Dialog open onClose={onCancel} data-testid="removeDeviceDialog">
            <DialogTitle>Remove device</DialogTitle>
            <DialogContent>
                <DialogContentText>
                    Remove <strong>{deviceDisplayName(state.device)}</strong> from sync? Sync history it was holding on to will be cleaned up.
                </DialogContentText>
                <DialogContentText sx={{ mt: 1.5 }}>
                    Removing does not sign the device out or block it. If it is still in use, it will simply re-register on its next sync and reappear here
                    after it re-downloads all your data — it will ask what to do with any unsynced changes, so nothing is discarded silently.
                </DialogContentText>
            </DialogContent>
            <DialogActions>
                <Button onClick={onCancel}>Cancel</Button>
                <Button variant="contained" color="warning" onClick={onConfirm} disabled={isRemoving} data-testid="confirmRemoveDeviceButton">
                    {isRemoving ? 'Removing…' : 'Remove'}
                </Button>
            </DialogActions>
        </Dialog>
    );
}

interface RenameDeviceDialogProps {
    device: ConnectedDevice;
    onCancel: () => void;
    onSubmit: (name: string) => void;
}

/** Mounted fresh per open (parent renders it conditionally, keyed by deviceId) — the useState initializer is the seeding mechanism. */
function RenameDeviceDialog({ device, onCancel, onSubmit }: RenameDeviceDialogProps) {
    const [name, setName] = useState(() => deviceDisplayName(device));
    const [nameError, setNameError] = useState<string | null>(null);

    function handleSave() {
        const trimmed = name.trim();
        if (trimmed === '') {
            setNameError('Name is required.');
            return;
        }
        if (trimmed.length > 64) {
            setNameError('Name must be 64 characters or fewer.');
            return;
        }
        onSubmit(trimmed);
    }

    return (
        <Dialog open onClose={onCancel} data-testid="renameDeviceDialog">
            <DialogTitle>Rename device</DialogTitle>
            <DialogContent>
                <TextField
                    autoFocus
                    fullWidth
                    size="small"
                    label="Name"
                    value={name}
                    onChange={(e) => {
                        setName(e.target.value);
                        if (nameError !== null) {
                            setNameError(null);
                        }
                    }}
                    error={nameError !== null}
                    helperText={nameError ?? ''}
                    autoComplete="off"
                    slotProps={{ htmlInput: { maxLength: 64 } }}
                    sx={{ mt: 1 }}
                    data-testid="deviceNameInput"
                />
            </DialogContent>
            <DialogActions>
                <Button onClick={onCancel}>Cancel</Button>
                <Button variant="contained" onClick={handleSave} data-testid="confirmRenameDeviceButton">
                    Save
                </Button>
            </DialogActions>
        </Dialog>
    );
}
