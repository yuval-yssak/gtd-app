import { API_SERVER } from '../constants/globals';
import type { EntityType, OpType, SyncOperation } from '../types/MyDB';
import { BootstrapRequiredError } from './bootstrapRequiredError';
import { fetchWithHeadersDeadline } from './deadlineSignal';
import { SyncAuthError } from './syncAuthError';
import { PUSH_TIMEOUT_MS } from './syncPushLimits';

export { BootstrapRequiredError } from './bootstrapRequiredError';
export { SyncAuthError } from './syncAuthError';
export { PUSH_BATCH_MAX, PUSH_TIMEOUT_MS } from './syncPushLimits';

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
    /** Optional for the same reason: servers predating the itemBrief entity omit it. */
    itemBriefs?: (Record<string, unknown> & { user: string })[];
    serverTs: string;
    serverId: string; // id component of the (held-back) compound cursor for the first incremental pull — '' on current servers
}

export interface PullPayload {
    ops: ServerOp[];
    serverTs: string;
    serverId: string; // `_id` of the last returned op (or the echoed `sinceId` when no ops) — next pull's `sinceId`
    /** More ops wait after this page. Absent from servers that predate paging — treat as false. */
    hasMore?: boolean;
}

/** A position in the op log, on the totally-ordered `(ts, _id)` pair. */
export interface OpCursor {
    ts: string;
    id: string;
}

/**
 * One page of `/sync/pull`. `cursor` is where to read from; `acked` is the highest cursor the device
 * has durably stored, which the server records as its purge floor. They are equal in steady state
 * but distinct by contract, so a lost or partially-applied response never advances the floor.
 */
export interface PullPageRequest {
    cursor: OpCursor;
    acked: OpCursor;
    deviceId: string;
    /** Most ops to return in this page. */
    limit: number;
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
 * What this device reports about itself on bootstrap and pull: its timezone and the build it runs.
 * `appVersion` is this bundle's commit hash — the code the installed Service Worker served — which
 * Settings → Connected devices shows per device.
 */
function deviceReportParams(): Record<string, string> {
    return { ...timezoneReportParam(), appVersion: __COMMIT_HASH__ };
}

/**
 * `timezone` query fragment, so server-side routine-item generation stamps dates on the user's
 * local calendar day (see `resolveUserTimezone` on the server). Empty when the environment can't
 * resolve an IANA name.
 */
function timezoneReportParam(): Record<string, string> {
    try {
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return timeZone ? { timezone: timeZone } : {};
    } catch {
        return {};
    }
}

/**
 * Deadlines for the idempotent sync reads, bounding the wait for response HEADERS only (the pull is
 * unpaginated — a long catch-up body over a slow link must still finish). On a network that never
 * answers ("lie-fi") the browser keeps a request open for minutes, and a hung pull holds the orchestrator's in-flight guard and the
 * session gate the whole time — so after the network recovers nothing syncs until it dies. Aborting
 * a read is safe: the next pass simply asks again. (`/sync/push` keeps its own, longer, deadline.)
 */
export const PULL_TIMEOUT_MS = 30_000;
/** Generous: a bootstrap ships the whole account, possibly over a slow link — only a true hang should hit it. */
export const BOOTSTRAP_TIMEOUT_MS = 120_000;
/** Small requests: the device-status probe and push registration's config read and subscribe. */
export const STATUS_PROBE_TIMEOUT_MS = 15_000;

/**
 * A request that is safe to abort and send again (a read, or an upsert like /push/subscribe). The
 * route names it in errors and logs; the deadline bounds the wait for headers.
 */
interface IdempotentRequest {
    route: string;
    url: string;
    init: RequestInit;
}

/** Fetches with a headers deadline; a timeout rejects with an Error naming the route, for the sync logs. */
async function fetchIdempotent({ route, url, init }: IdempotentRequest, deadlineMs: number): Promise<Response> {
    try {
        return await fetchWithHeadersDeadline(url, { ...init, deadlineMs });
    } catch (err) {
        throw isTimeoutAbort(err) ? new Error(`${route} timed out after ${deadlineMs}ms`) : err;
    }
}

export async function pushSyncOps(deviceId: string, ops: SyncOperation[]): Promise<void> {
    const res = await fetch(`${API_SERVER}/sync/push`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', [DEVICE_ID_HEADER]: deviceId },
        body: JSON.stringify({ deviceId, ops }),
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    }).catch((err: unknown) => {
        throw isTimeoutAbort(err) ? new Error(`POST /sync/push timed out after ${PUSH_TIMEOUT_MS}ms`) : err;
    });
    if (!res.ok) throwForStatus(res, 'POST /sync/push');
}

/** `AbortSignal.timeout` rejects the fetch with a DOMException named TimeoutError; the message above names the cause for the sync logs. */
function isTimeoutAbort(err: unknown): boolean {
    return err instanceof DOMException && err.name === 'TimeoutError';
}

export async function fetchBootstrap(deviceId: string, deviceLabel?: string): Promise<BootstrapPayload> {
    // Sending deviceId in the query string lets the server register a deviceSyncState row at
    // bootstrap time, so its purge floor is established before any sibling device pulls. Without
    // it the floor could drop below ops this device still needs (sync race).
    // deviceLabel ("Chrome on macOS") rides along so the row is displayable in Settings →
    // Connected devices; bootstrap is the row's sole creation path, so this is the one chance.
    const params = new URLSearchParams({ deviceId, ...deviceReportParams() });
    if (deviceLabel) {
        params.set('deviceLabel', deviceLabel);
    }
    const res = await fetchIdempotent(
        {
            route: 'GET /sync/bootstrap',
            url: `${API_SERVER}/sync/bootstrap?${params}`,
            init: { credentials: 'include', headers: { [DEVICE_ID_HEADER]: deviceId } },
        },
        BOOTSTRAP_TIMEOUT_MS,
    );
    if (!res.ok) throwForStatus(res, 'GET /sync/bootstrap');
    return res.json() as Promise<BootstrapPayload>;
}

// Ops are paginated on the compound `(ts, _id)` cursor, so a same-`ts` batch split across pages loses
// nothing. See PullPageRequest for the since/ack contract.
export async function fetchSyncOps({ cursor, acked, deviceId, limit }: PullPageRequest): Promise<PullPayload> {
    const params = new URLSearchParams({
        since: cursor.ts,
        sinceId: cursor.id,
        ackedTs: acked.ts,
        ackedId: acked.id,
        deviceId,
        limit: String(limit),
        ...deviceReportParams(),
    });
    const res = await fetchIdempotent(
        { route: 'GET /sync/pull', url: `${API_SERVER}/sync/pull?${params}`, init: { credentials: 'include', headers: { [DEVICE_ID_HEADER]: deviceId } } },
        PULL_TIMEOUT_MS,
    );
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
    const res = await fetchIdempotent(
        {
            route: 'GET /sync/device-status',
            url: `${API_SERVER}/sync/device-status?${params}`,
            init: { credentials: 'include', headers: { [DEVICE_ID_HEADER]: deviceId } },
        },
        STATUS_PROBE_TIMEOUT_MS,
    );
    if (!res.ok) throwForStatus(res, 'GET /sync/device-status');
    return res.json() as Promise<{ registered: boolean }>;
}

/**
 * Throws on an error answer or a hang, so the connection supervisor retries push registration; only a
 * server that has no push keys configured answers `{ vapidPublicKey: null }`.
 */
export async function fetchVapidConfig(): Promise<{ vapidPublicKey: string | null }> {
    const res = await fetchIdempotent(
        { route: 'GET /sync/config', url: `${API_SERVER}/sync/config`, init: { credentials: 'include' } },
        STATUS_PROBE_TIMEOUT_MS,
    );
    if (!res.ok) throwForStatus(res, 'GET /sync/config');
    return res.json() as Promise<{ vapidPublicKey: string | null }>;
}

export async function registerPushEndpoint(deviceId: string, subscription: PushSubscriptionJSON): Promise<void> {
    const res = await fetchIdempotent(
        {
            route: 'POST /push/subscribe',
            url: `${API_SERVER}/push/subscribe`,
            init: {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json', [DEVICE_ID_HEADER]: deviceId },
                body: JSON.stringify({ deviceId, endpoint: subscription.endpoint, keys: subscription.keys }),
            },
        },
        STATUS_PROBE_TIMEOUT_MS,
    );
    if (!res.ok) throwForStatus(res, 'POST /push/subscribe');
}
