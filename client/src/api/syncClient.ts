import { API_SERVER } from '../constants/globals';
import type { EntityType, OpType, SyncOperation } from '../types/MyDB';
import { BootstrapRequiredError } from './bootstrapRequiredError';
import { SyncAuthError } from './syncAuthError';

export { BootstrapRequiredError } from './bootstrapRequiredError';
export { SyncAuthError } from './syncAuthError';

// ── Shared server-facing types ────────────────────────────────────────────────
// Exported so syncHelpers.ts can reference them without importing from this path directly.

// Shape of a single op returned by GET /sync/pull — snapshot uses `user` (server field name)
export interface ServerOp {
    entityType: EntityType;
    entityId: string;
    opType: OpType;
    snapshot: (Record<string, unknown> & { user?: string }) | null;
}

export interface BootstrapPayload {
    items: (Record<string, unknown> & { user: string })[];
    routines: (Record<string, unknown> & { user: string })[];
    people: (Record<string, unknown> & { user: string })[];
    workContexts: (Record<string, unknown> & { user: string })[];
    /** Optional: a server deployed before the reviewInboxes entity omits this field. */
    reviewInboxes?: (Record<string, unknown> & { user: string })[];
    serverTs: string;
    serverId: string; // id component of the (held-back) compound cursor for the first incremental pull — '' on current servers
}

export interface PullPayload {
    ops: ServerOp[];
    serverTs: string;
    serverId: string; // `_id` of the last returned op (or the echoed `sinceId` when no ops) — next pull's `sinceId`
}

// ── Network functions ─────────────────────────────────────────────────────────
// All fetch() calls in the client must live here. Import via the '#api/syncClient'
// alias — never via a relative path — so tests automatically get the mock companion.

// Sent on every authenticated request so the auth middleware can keep `deviceUsers`
// fresh — see api-server/src/auth/middleware.ts.
const DEVICE_ID_HEADER = 'X-Device-Id';

function throwForStatus(res: Response, context: string): never {
    if (res.status === 401) {
        throw new SyncAuthError(context);
    }
    throw new Error(`${context} ${res.status}`);
}

/**
 * `timezone` query fragment reported on bootstrap and pull, so server-side routine-item
 * generation stamps dates on the user's local calendar day (see `resolveUserTimezone` on the
 * server). Spread into URLSearchParams — empty when the environment can't resolve an IANA name.
 */
function timezoneReportParam(): Record<string, string> {
    try {
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return timeZone ? { timezone: timeZone } : {};
    } catch {
        return {};
    }
}

export async function pushSyncOps(deviceId: string, ops: SyncOperation[]): Promise<void> {
    const res = await fetch(`${API_SERVER}/sync/push`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', [DEVICE_ID_HEADER]: deviceId },
        body: JSON.stringify({ deviceId, ops }),
    });
    if (!res.ok) throwForStatus(res, 'POST /sync/push');
}

export async function fetchBootstrap(deviceId: string, deviceLabel?: string): Promise<BootstrapPayload> {
    // Sending deviceId in the query string lets the server register a deviceSyncState row at
    // bootstrap time, so its purge floor is established before any sibling device pulls. Without
    // it the floor could drop below ops this device still needs (sync race).
    // deviceLabel ("Chrome on macOS") rides along so the row is displayable in Settings →
    // Connected devices; bootstrap is the row's sole creation path, so this is the one chance.
    const params = new URLSearchParams({ deviceId, ...timezoneReportParam() });
    if (deviceLabel) {
        params.set('deviceLabel', deviceLabel);
    }
    const res = await fetch(`${API_SERVER}/sync/bootstrap?${params}`, {
        credentials: 'include',
        headers: { [DEVICE_ID_HEADER]: deviceId },
    });
    if (!res.ok) throwForStatus(res, 'GET /sync/bootstrap');
    return res.json() as Promise<BootstrapPayload>;
}

// The cursor is the compound pair `(since, sinceId)` — ops are paginated on `(ts, _id)` so a same-`ts`
// batch can't be split across pulls and lose ops. `(ackedTs, ackedId)` is the highest pair the caller
// has *durably persisted to IndexedDB*; the server records it as the device's purge floor — distinct
// from `(since, sinceId)` so a lost or partial response never advances the floor past ops the client
// never committed. In steady state callers pass the ack pair equal to the since pair.
export async function fetchSyncOps(since: string, sinceId: string, ackedTs: string, ackedId: string, deviceId: string): Promise<PullPayload> {
    const params = new URLSearchParams({ since, sinceId, ackedTs, ackedId, deviceId, ...timezoneReportParam() });
    const res = await fetch(`${API_SERVER}/sync/pull?${params}`, {
        credentials: 'include',
        headers: { [DEVICE_ID_HEADER]: deviceId },
    });
    // 409 = the server has no deviceSyncState row for this (device, user): the device was reaped
    // while offline and its cursor can no longer be trusted (ops may be purged). Typed error so
    // callers route into the bootstrap-recovery flow instead of retrying the pull forever.
    if (res.status === 409) {
        throw new BootstrapRequiredError('GET /sync/pull');
    }
    if (!res.ok) throwForStatus(res, 'GET /sync/pull');
    return res.json() as Promise<PullPayload>;
}

/**
 * Probe used BEFORE flushing a non-empty offline queue: when `registered` is false this device was
 * reaped server-side and the user must choose push-vs-discard before any auto-flush runs (pushing
 * first would moot the choice — see the probe-before-flush design in multiUserSync.syncOneUser).
 */
export async function fetchDeviceStatus(deviceId: string): Promise<{ registered: boolean }> {
    const params = new URLSearchParams({ deviceId });
    const res = await fetch(`${API_SERVER}/sync/device-status?${params}`, {
        credentials: 'include',
        headers: { [DEVICE_ID_HEADER]: deviceId },
    });
    if (!res.ok) throwForStatus(res, 'GET /sync/device-status');
    return res.json() as Promise<{ registered: boolean }>;
}

// Returns { vapidPublicKey: null } on failure so the caller degrades gracefully without throwing.
export async function fetchVapidConfig(): Promise<{ vapidPublicKey: string | null }> {
    const res = await fetch(`${API_SERVER}/sync/config`, { credentials: 'include' });
    if (!res.ok) return { vapidPublicKey: null };
    return res.json() as Promise<{ vapidPublicKey: string | null }>;
}

export async function registerPushEndpoint(deviceId: string, subscription: PushSubscriptionJSON): Promise<void> {
    await fetch(`${API_SERVER}/push/subscribe`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', [DEVICE_ID_HEADER]: deviceId },
        body: JSON.stringify({ deviceId, endpoint: subscription.endpoint, keys: subscription.keys }),
    });
}
