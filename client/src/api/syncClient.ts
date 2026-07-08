import { API_SERVER } from '../constants/globals';
import type { EntityType, OpType, SyncOperation } from '../types/MyDB';
import { SyncAuthError } from './syncAuthError';

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
    serverTs: string;
    serverId: string; // MAX_OP_ID — the id component of the compound cursor for the first incremental pull
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

export async function pushSyncOps(deviceId: string, ops: SyncOperation[]): Promise<void> {
    const res = await fetch(`${API_SERVER}/sync/push`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', [DEVICE_ID_HEADER]: deviceId },
        body: JSON.stringify({ deviceId, ops }),
    });
    if (!res.ok) throwForStatus(res, 'POST /sync/push');
}

export async function fetchBootstrap(deviceId: string): Promise<BootstrapPayload> {
    // Sending deviceId in the query string lets the server register a deviceSyncState row at
    // bootstrap time, so its purge floor is established before any sibling device pulls. Without
    // it the floor could drop below ops this device still needs (sync race).
    const res = await fetch(`${API_SERVER}/sync/bootstrap?deviceId=${encodeURIComponent(deviceId)}`, {
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
    const params = new URLSearchParams({ since, sinceId, ackedTs, ackedId, deviceId });
    const res = await fetch(`${API_SERVER}/sync/pull?${params}`, {
        credentials: 'include',
        headers: { [DEVICE_ID_HEADER]: deviceId },
    });
    if (!res.ok) throwForStatus(res, 'GET /sync/pull');
    return res.json() as Promise<PullPayload>;
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
