import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import type { IDBPDatabase } from 'idb';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ConnectedDevice, listConnectedDevices, removeDevice, renameDevice } from '../../api/devicesApi';
import { getOrCreateDeviceId } from '../../db/deviceId';
import { AlertDialog, Button, Chip, Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle, Text, TextField } from '../../designSystem';
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
            <Text variant="bodySm" tone="secondary" className={styles.loadingState}>
                Loading devices…
            </Text>
        );
    }
    if (loadError) {
        return (
            <Text variant="bodySm" tone="error" data-testid="devicesLoadError">
                {loadError}
            </Text>
        );
    }
    return (
        <div>
            <DeviceList devices={devices} currentDeviceId={currentDeviceId} removingId={removingId} onRemove={openRemove} onRename={openRename} />
            {freedSummary && (
                <Text variant="bodySm" tone="success" className={styles.freedSummary} data-testid="deviceRemovedSummary">
                    {freedSummary}
                </Text>
            )}
            {actionError && (
                <Text variant="bodySm" tone="error" data-testid="devicesActionError">
                    {actionError}
                </Text>
            )}
            <Text as="p" variant="caption" tone="secondary" className={styles.opsSummary} data-testid="opsLogSummary">
                Sync history: {totalOps} operation{totalOps === 1 ? '' : 's'} retained. History older than what every connected device has received is cleaned
                up automatically.
            </Text>
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
        </div>
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
            <Text variant="bodySm" tone="secondary" data-testid="devicesEmptyState">
                No devices are registered for sync yet.
            </Text>
        );
    }
    return (
        <ul className={styles.list} data-testid="deviceList">
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
        </ul>
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
        <li className={styles.row} data-testid="deviceRow">
            <div className={styles.rowText}>
                <span className={styles.primaryLine}>
                    <Text as="span">{deviceDisplayName(device)}</Text>
                    {isCurrentDevice && <Chip tone="accent" variant="outline" label="This device" data-testid="thisDeviceChip" />}
                    {isHoldingBackCleanup(device) && <Chip tone="warning" variant="outline" label="Holding back cleanup" data-testid="holdingCleanupChip" />}
                </span>
                <Text as="span" variant="bodySm" tone="secondary">
                    {describeDeviceActivity(device)}
                </Text>
            </div>
            <div className={styles.rowActions}>
                <Button size="sm" onClick={() => onRename(device)} data-testid="renameDeviceButton">
                    Rename
                </Button>
                {/* No Remove for the device you're on: removing it would only force this very
                    browser through a full re-download on its next sync — never what's meant here. */}
                {!isCurrentDevice && (
                    <Button size="sm" tone="danger" onClick={() => onRemove(device)} disabled={isRemoving} data-testid="removeDeviceButton">
                        {isRemoving ? 'Removing…' : 'Remove'}
                    </Button>
                )}
            </div>
        </li>
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
        <AlertDialog open onClose={onCancel} size="sm" data-testid="removeDeviceDialog">
            <DialogTitle>Remove device</DialogTitle>
            {/* Base UI links one description per popup, so the confirm question is the description
                and the explanation that follows is plain text. */}
            <DialogDescription>
                Remove <strong>{deviceDisplayName(state.device)}</strong> from sync? Sync history it was holding on to will be cleaned up.
            </DialogDescription>
            <Text tone="secondary" className={styles.followingParagraph}>
                Removing does not sign the device out or block it. If it is still in use, it will simply re-register on its next sync and reappear here after it
                re-downloads all your data — it will ask what to do with any unsynced changes, so nothing is discarded silently.
            </Text>
            <DialogActions>
                <Button onClick={onCancel}>Cancel</Button>
                <Button variant="solid" tone="danger" onClick={onConfirm} disabled={isRemoving} data-testid="confirmRemoveDeviceButton">
                    {isRemoving ? 'Removing…' : 'Remove'}
                </Button>
            </DialogActions>
        </AlertDialog>
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
        <Dialog open onClose={onCancel} size="xs" fullWidth data-testid="renameDeviceDialog">
            <DialogTitle>Rename device</DialogTitle>
            <DialogContent>
                <TextField
                    autoFocus
                    fullWidth
                    size="sm"
                    label="Name"
                    value={name}
                    onChange={(e) => {
                        setName(e.target.value);
                        if (nameError !== null) {
                            setNameError(null);
                        }
                    }}
                    error={nameError !== null}
                    helperText={nameError ?? undefined}
                    autoComplete="off"
                    inputProps={{ maxLength: 64 }}
                    data-testid="deviceNameInput"
                />
            </DialogContent>
            <DialogActions>
                <Button onClick={onCancel}>Cancel</Button>
                <Button variant="solid" onClick={handleSave} data-testid="confirmRenameDeviceButton">
                    Save
                </Button>
            </DialogActions>
        </Dialog>
    );
}
