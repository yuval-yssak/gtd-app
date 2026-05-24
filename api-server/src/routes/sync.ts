import dayjs from 'dayjs';
import { Hono } from 'hono';
import { authenticateRequest } from '../auth/middleware.js';
import deviceSyncStateDAO from '../dataAccess/deviceSyncStateDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import peopleDAO from '../dataAccess/peopleDAO.js';
import pushSubscriptionsDAO from '../dataAccess/pushSubscriptionsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import workContextsDAO from '../dataAccess/workContextsDAO.js';
import { applyAndPublishOperations, OperationValidationError, type RawOperation } from '../lib/applyOperation.js';
import { buildCalendarProvider } from '../lib/buildCalendarProvider.js';
import { type ReassignParams, reassignEntity } from '../lib/reassignEntity.js';
import { addSseConnection, notifyUserViaSse, removeSseConnection } from '../lib/sseConnections.js';
import { vapidPublicKey } from '../lib/webPush.js';
import { auth } from '../loaders/mainLoader.js';
import type { AuthVariables } from '../types/authTypes.js';
import { deviceSyncStateId, type EntitySnapshot, type EntityType, type OpType, type RsvpOpPayload } from '../types/entities.js';
import { syncIssuesRoutes } from './syncIssues.js';

// Shape of each operation as sent by the client — mirrors the client SyncOperation type.
// Snapshot uses `userId` (IndexedDB field name); the server remaps it to `user`.
interface ClientOp {
    entityType: EntityType;
    entityId: string;
    opType: OpType;
    queuedAt: string;
    snapshot: (Record<string, unknown> & { userId?: string }) | null;
    /**
     * Sidecar populated by the client's SendUpdatesDialog choice on calendar-item edits. Carried
     * verbatim onto the persisted operation so GCal pushback can forward it to provider calls.
     */
    gcalMeta?: { sendUpdates: 'all' | 'none' };
    /**
     * Required when `opType === 'rsvp'`. The replay path (lib/rsvpReplay.ts) reads this off the
     * persisted op to drive `events.patch` after a long offline period.
     */
    rsvp?: RsvpOpPayload;
}

const STALE_DEVICE_DAYS = 90;

async function purgeStaleDevices(userId: string): Promise<void> {
    const cutoffTs = dayjs().subtract(STALE_DEVICE_DAYS, 'day').toISOString();
    const staleDeviceIds = await deviceSyncStateDAO.deleteStaleDevices(userId, cutoffTs);
    if (!staleDeviceIds.length) {
        return;
    }

    console.log(`[purge] removed ${staleDeviceIds.length} stale device(s) for user ${userId}: ${staleDeviceIds.join(', ')}`);
    await pushSubscriptionsDAO.deleteByDeviceIds(staleDeviceIds, userId);
}

async function purgeOldOperations(userId: string): Promise<void> {
    // Remove stale devices first so they no longer hold back the purge floor
    await purgeStaleDevices(userId);

    const deviceStates = await deviceSyncStateDAO.findArray({ user: userId });
    if (!deviceStates.length) return;

    // Only purge ops all registered devices have already pulled — the slowest device sets the floor.
    // reduce without an initial value uses the first element as the accumulator seed; TypeScript
    // types this as returning the element type (not T | undefined), safe since we guard length above.
    const minLastSyncedTs = deviceStates.map((d) => d.lastSyncedTs).reduce((min, ts) => (ts < min ? ts : min));

    await operationsDAO.deleteOlderThan(userId, minLastSyncedTs);
}

/**
 * Validates that the SSE channel request targets a user with a session on this device.
 * Returns the resolved channel userId, or `null` if the requested userId is not a member
 * of the device's session set. Falls back to `activeUserId` when no `?userId` is provided
 * so legacy single-channel callers keep working.
 */
async function resolveSseChannelUserId(headers: Headers, activeUserId: string, requestedUserId: string | undefined): Promise<string | null> {
    if (!requestedUserId) {
        return activeUserId;
    }
    if (requestedUserId === activeUserId) {
        return activeUserId;
    }
    const sessions = await auth.api.listDeviceSessions({ headers });
    const isMember = sessions.some((s) => s.user.id === requestedUserId);
    return isMember ? requestedUserId : null;
}

export const syncRoutes = new Hono<{ Variables: AuthVariables }>()
    // ---------------------------------------------------------------------------
    // GET /sync/bootstrap  — full entity snapshot for new/re-syncing devices
    // ---------------------------------------------------------------------------
    // New devices cannot use /sync/pull because historical ops may have been purged
    // before the device registered. Bootstrap reads directly from entity collections
    // (the permanent ground truth) and returns serverTs so the device can start
    // incremental pull from that point forward without replaying any ops.
    .get('/bootstrap', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const deviceId = c.req.query('deviceId');
        // One serverTs for both the response body and the deviceSyncState row, so the recorded
        // floor exactly matches what the client claims it has after consuming this response.
        const serverTs = dayjs().toISOString();

        const [items, routines, people, workContexts] = await Promise.all([
            itemsDAO.findArray({ user: user.id }),
            routinesDAO.findArray({ user: user.id }),
            peopleDAO.findArray({ user: user.id }),
            workContextsDAO.findArray({ user: user.id }),
        ]);

        // Register the device as soon as we've decided what's in the response. Bootstrap delivers
        // a full snapshot — by the time `fetchBootstrap` resolves on the client, IndexedDB will
        // hold everything ≤ serverTs, so writing `lastSyncedTs: serverTs` is honest. We await
        // the upsert so a sibling device that pulls before this device's first incremental pull
        // can't drop the purge floor through the missing row (its pull would have computed
        // `min(lastSyncedTs)` excluding this device, potentially deleting ops this device needs).
        if (deviceId) {
            await deviceSyncStateDAO.updateOne(
                { _id: deviceSyncStateId(deviceId, user.id) },
                { $set: { lastSyncedTs: serverTs, deviceId, user: user.id }, $setOnInsert: { lastSeenTs: dayjs(0).toISOString() } },
                { upsert: true },
            );
        }

        return c.json({ items, routines, people, workContexts, serverTs });
    })

    // ---------------------------------------------------------------------------
    // POST /sync/push  — client sends a batch of queued operations
    // ---------------------------------------------------------------------------
    .post('/push', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const { deviceId, ops } = await c.req.json<{ deviceId: string; ops: ClientOp[] }>();
        if (!ops.length) {
            return c.json({ ok: true }, 200);
        }

        // Misroute guard: the contract is "ops in this batch belong to the active session".
        // Cross-account flushes must use syncAllLoggedInUsers/syncOneUser, which pivots the
        // active session before flushing. If a snapshot still carries a userId tag and it
        // disagrees with the session, the previous flow would silently overwrite and corrupt
        // data (the bug that put item ebd197ea-… under the wrong user). Fail loudly instead.
        // We check `snapshot.userId` (IndexedDB field name) — server entities use `user`, but
        // the client's remapUser stamps the IDB-style `userId` onto outbound op snapshots.
        // `snapshot: null` (delete ops) flows through unchecked — the active session is the only
        // signal we have for ownership and the deleteByOwner path scopes by session.user.id anyway.
        const mismatched = ops.find((op) => op.snapshot?.userId !== undefined && op.snapshot.userId !== user.id);
        if (mismatched) {
            return c.json(
                {
                    error: `Op userId mismatch: ${mismatched.opType}:${mismatched.entityType}:${mismatched.entityId} tagged userId=${mismatched.snapshot?.userId} but session user.id=${user.id}. Use syncAllLoggedInUsers/syncOneUser for cross-account flushes.`,
                },
                400,
            );
        }

        console.log(
            `[sync-push] received from device=${deviceId} | ops=${ops.length}`,
            ops.map((op) => `${op.opType}:${op.entityType}:${op.entityId}`),
        );

        const now = dayjs().toISOString();

        // Strip client-side `userId` and let `applyAndPublishOperations` stamp the
        // server-authoritative `user`. The misroute guard above already ensured no snapshot tags
        // disagree with the active session; we still re-stamp inside the pipeline as a defense.
        // gcalMeta and rsvp ride along untouched — the pipeline forwards them onto the persisted
        // op so `maybePushToGCal` can read sendUpdates and `replayRsvpOp` can drive events.patch
        // for offline RSVPs.
        const rawOps: RawOperation[] = ops.map((op) => {
            const { userId: _stripped, ...snapshotFields } = op.snapshot ?? {};
            const snapshot = op.snapshot ? ({ ...snapshotFields, user: user.id } as EntitySnapshot) : null;
            return {
                entityType: op.entityType,
                entityId: op.entityId,
                opType: op.opType,
                snapshot,
                ...(op.gcalMeta ? { gcalMeta: op.gcalMeta } : {}),
                ...(op.rsvp ? { rsvp: op.rsvp } : {}),
            };
        });

        // Strict-mode validation: a malformed op aborts the entire batch with a structured 400.
        // No partial application — the client retries the whole batch after fixing the offender.
        try {
            await applyAndPublishOperations(user.id, rawOps, { deviceId, now, strict: true });
        } catch (err) {
            if (err instanceof OperationValidationError) {
                return c.json(
                    {
                        error: err.failure.message,
                        code: err.failure.code,
                        ...(err.failure.path?.length ? { path: err.failure.path } : {}),
                        ...(err.failure.extra ? { extra: err.failure.extra } : {}),
                    },
                    400,
                );
            }
            throw err;
        }

        console.log(`[sync-push] applied ops via shared pipeline`);

        // Per-(device, user) cursor — see DeviceSyncStateInterface. A single shared per-device row
        // would let user A's pull advance the cursor past user B's boundary op on the same device.
        await deviceSyncStateDAO.updateOne(
            { _id: deviceSyncStateId(deviceId, user.id) },
            { $set: { lastSeenTs: now, deviceId, user: user.id }, $setOnInsert: { lastSyncedTs: dayjs(0).toISOString() } },
            { upsert: true },
        );

        return c.json({ ok: true }, 200);
    })

    // ---------------------------------------------------------------------------
    // GET /sync/pull  — client fetches operations it hasn't seen yet
    // ---------------------------------------------------------------------------
    .get('/pull', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const since = c.req.query('since') ?? dayjs(0).toISOString();
        // Explicit acknowledgement: the highest ts the client has *durably persisted to IndexedDB*.
        // Distinct from `since` (which ops to fetch) so that a lost or partially-applied pull
        // response cannot advance the purge floor past ops the client never committed. Old clients
        // that don't send `ackedTs` fall back to `since` — strictly safer than the previous
        // `serverTs`, since `since` is what those clients claimed they had before this fetch.
        const ackedTs = c.req.query('ackedTs');
        const deviceId = c.req.query('deviceId');

        const ops = await operationsDAO.findArray({ user: user.id, ts: { $gt: since } }, { sort: { ts: 1 } });

        // The response's `serverTs` marks the high-water mark of *what we just returned* — the
        // client uses it as the next pull's `since`. It is NOT the purge floor. The purge floor
        // lives in `deviceSyncState.lastSyncedTs`, which is now driven by `ackedTs` (below).
        // Known limitation on `serverTs`: if another push commits ops at exactly `lastOp.ts` after
        // this query ran, the next pull ($gt: lastOp.ts) will miss them. Acceptable for the
        // low-throughput GTD use case; a monotonic sequence would eliminate the gap.
        const lastOp = ops.at(-1);
        const serverTs = lastOp ? lastOp.ts : since;

        if (deviceId) {
            // Track per-(device, user) pull cursor so old operations can eventually be purged.
            // Composite _id keeps each user's cursor independent — see DeviceSyncStateInterface.
            // We record `ackedTs` (what the client claims it has) rather than `serverTs` (what
            // we're about to return). Pre-fix this wrote `serverTs` and a lost/partial response
            // could cause the next purge to delete ops the client never received — the LinkedIn
            // inbox bug. See plans/write-up-a-plan-zesty-pebble.md.
            await deviceSyncStateDAO.updateOne(
                { _id: deviceSyncStateId(deviceId, user.id) },
                { $set: { lastSyncedTs: ackedTs ?? since, deviceId, user: user.id }, $setOnInsert: { lastSeenTs: dayjs(0).toISOString() } },
                { upsert: true },
            );

            // Fire-and-forget: purge ops all (device, user) rows have already seen to cap storage growth.
            // Async so the pull response isn't blocked by the deletion query.
            purgeOldOperations(user.id).catch(() => {});
        }

        return c.json({ ops, serverTs });
    })

    // ---------------------------------------------------------------------------
    // GET /events  — SSE stream; server pushes { type: 'update', ts } on changes
    // ---------------------------------------------------------------------------
    // When `?userId=<uuid>` is present, the client is asking for the channel of a
    // specific session on this device (multi-account support — one EventSource per
    // logged-in user). We validate the requested user is one of the device's sessions
    // (via the multi-session cookie) and reject with 403 otherwise. Without the param,
    // we fall back to the active session's user id for backward compatibility.
    .get('/events', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const requestedUserId = c.req.query('userId');
        const channelUserId = await resolveSseChannelUserId(c.req.raw.headers, user.id, requestedUserId);
        if (!channelUserId) {
            return c.json({ error: 'Forbidden: requested userId is not a session on this device' }, 403);
        }

        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                addSseConnection(channelUserId, controller);

                // Initial comment keeps the connection open and confirms it's alive to the client
                controller.enqueue(new TextEncoder().encode(': connected\n\n'));

                // Remove from map when client disconnects; EventSource will auto-reconnect
                c.req.raw.signal.addEventListener('abort', () => {
                    removeSseConnection(channelUserId, controller);
                    try {
                        controller.close();
                    } catch {
                        /* already closed */
                    }
                });
            },
        });

        return new Response(stream, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                // Disable proxy/CDN buffering so events reach the client immediately
                'X-Accel-Buffering': 'no',
            },
        });
    })

    // GET /sync/config — exposes the VAPID public key so the client can subscribe without a secret
    .get('/config', (c) => c.json({ vapidPublicKey }))

    // ---------------------------------------------------------------------------
    // POST /sync/reassign  — atomically move an entity from fromUserId to toUserId
    // ---------------------------------------------------------------------------
    // Both fromUserId and toUserId must be sessions on this device (we read the device-multi-session
    // cookie so a single tab can drive cross-account moves). The handler validates membership before
    // touching the DB so a forged userId in the body can't be used to delete another user's data.
    // For calendar-linked items, the helper does the GCal create-on-target → delete-on-source dance
    // and rolls back to a 502 with no DB writes if the create fails.
    .post('/reassign', authenticateRequest, async (c) => {
        const params = await c.req.json<ReassignParams>();
        const guard = await validateReassignSessions(c.req.raw.headers, params);
        if (!guard.ok) {
            return c.json({ error: guard.error }, guard.status);
        }
        const result = await reassignEntity(params, buildCalendarProvider);
        if (!result.ok) {
            return c.json({ error: result.error }, result.status);
        }
        // Notify both source and target SSE channels so each device-side consumer can pull the
        // delete and create ops respectively. Without these the user would have to wait for the
        // next pull cycle to see the entity move across views.
        const now = dayjs().toISOString();
        notifyUserViaSse(params.fromUserId, { type: 'update', ts: now });
        notifyUserViaSse(params.toUserId, { type: 'update', ts: now });
        return c.json({ ok: true, ...(result.crossUserReferences ? { crossUserReferences: result.crossUserReferences } : {}) }, 200);
    })

    // ---------------------------------------------------------------------------
    // /sync/issues — Sync Issues panel surface (list / dismiss / retry)
    // ---------------------------------------------------------------------------
    // Mounted as a sub-router so the failed-op endpoints stay grouped under /sync without
    // bloating this file. Auth + tenant scoping live inside syncIssues.ts.
    .route('/issues', syncIssuesRoutes);

type ReassignGuardResult = { ok: true } | { ok: false; status: 400 | 403; error: string };

/**
 * Validates the body and ensures both fromUserId and toUserId have a Better Auth session on this
 * device. Reads `auth.api.listDeviceSessions` exactly like the SSE channel guard. Without this
 * check, a logged-in attacker could forge `fromUserId` in the body to delete another user's data.
 */
async function validateReassignSessions(headers: Headers, params: ReassignParams): Promise<ReassignGuardResult> {
    if (!params.entityType || !params.entityId || !params.fromUserId || !params.toUserId) {
        return { ok: false, status: 400, error: 'entityType, entityId, fromUserId, toUserId are required' };
    }
    if (params.fromUserId === params.toUserId) {
        return { ok: false, status: 400, error: 'fromUserId and toUserId must differ' };
    }
    const sessions = await auth.api.listDeviceSessions({ headers });
    const sessionUserIds = new Set(sessions.map((s) => s.user.id));
    if (!sessionUserIds.has(params.fromUserId) || !sessionUserIds.has(params.toUserId)) {
        return { ok: false, status: 403, error: 'Forbidden: both fromUserId and toUserId must be sessions on this device' };
    }
    return { ok: true };
}
