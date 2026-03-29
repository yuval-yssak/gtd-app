import { API_SERVER } from '../constants/globals';
import type { EntityType, OpType, SyncOperation } from '../types/MyDB';

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
}

export interface PullPayload {
    ops: ServerOp[];
    serverTs: string;
}

// ── Network functions ─────────────────────────────────────────────────────────
// All fetch() calls in the client must live here. Import via the '#api/syncClient'
// alias — never via a relative path — so tests automatically get the mock companion.

export async function pushSyncOps(deviceId: string, ops: SyncOperation[]): Promise<void> {
    const res = await fetch(`${API_SERVER}/sync/push`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, ops }),
    });
    if (!res.ok) throw new Error(`POST /sync/push ${res.status}`);
}

export async function fetchBootstrap(): Promise<BootstrapPayload> {
    const res = await fetch(`${API_SERVER}/sync/bootstrap`, { credentials: 'include' });
    if (!res.ok) throw new Error(`GET /sync/bootstrap ${res.status}`);
    return res.json() as Promise<BootstrapPayload>;
}

export async function fetchSyncOps(since: string, deviceId: string): Promise<PullPayload> {
    const res = await fetch(`${API_SERVER}/sync/pull?since=${encodeURIComponent(since)}&deviceId=${encodeURIComponent(deviceId)}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`GET /sync/pull ${res.status}`);
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, endpoint: subscription.endpoint, keys: subscription.keys }),
    });
}
