import { API_SERVER } from '../constants/globals';

/** One row of GET /devices — this account's sync state on a single physical device. */
export interface ConnectedDevice {
    deviceId: string;
    /** User-given name (set via renameDevice). Wins over autoLabel for display. */
    name?: string;
    /** Client-derived label captured at bootstrap, e.g. "Chrome on macOS". */
    autoLabel?: string;
    lastSeenTs: string;
    lastSyncedTs: string;
    /** Operations recorded after this device's pull cursor — what it would have to catch up on. */
    opsBehind: number;
    /** True when this device's cursor IS the purge floor — it's holding back op-log cleanup. */
    holdsPurgeFloor: boolean;
}

export interface ConnectedDevicesPayload {
    devices: ConnectedDevice[];
    /** Total operations currently retained in this account's op log. */
    totalOps: number;
}

interface ErrorBody {
    error?: string;
}

/** Thin wrapper around fetch errors so callers can branch on status (e.g. 404 = already removed). */
export class DevicesApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
    // credentials: 'include' — Better Auth session cookie travels cross-origin (client ≠ API domain).
    const response = await fetch(`${API_SERVER}${path}`, { credentials: 'include', ...init });
    if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ErrorBody;
        throw new DevicesApiError(response.status, body.error ?? `devices API error ${response.status}`);
    }
    return response;
}

export async function listConnectedDevices(): Promise<ConnectedDevicesPayload> {
    const res = await apiFetch('/devices');
    return (await res.json()) as ConnectedDevicesPayload;
}

export async function renameDevice(deviceId: string, name: string): Promise<void> {
    await apiFetch(`/devices/${encodeURIComponent(deviceId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
    });
}

/** Removes the (device, this account) sync row. Returns how many operations the purge freed. */
export async function removeDevice(deviceId: string): Promise<{ purgedOps: number }> {
    const res = await apiFetch(`/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
    return (await res.json()) as { purgedOps: number };
}
