import dayjs from 'dayjs';
import { Hono } from 'hono';
import { authenticateRequest } from '../auth/middleware.js';
import deviceSyncStateDAO from '../dataAccess/deviceSyncStateDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import peopleDAO from '../dataAccess/peopleDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import workContextsDAO from '../dataAccess/workContextsDAO.js';
import { applyAndPublishOperations, OperationValidationError, type RawOperation } from '../lib/applyOperation.js';
import { buildCalendarProvider } from '../lib/buildCalendarProvider.js';
import { computePurgeFloor, STALE_DEVICE_DAYS } from '../lib/purgeFloor.js';
import { type ReassignParams, reassignEntity } from '../lib/reassignEntity.js';
import { addSseConnection, notifyUserViaSse, removeSseConnection } from '../lib/sseConnections.js';
import { reapStaleDevices } from '../lib/staleDevices.js';
import { hasAtLeastOne } from '../lib/typeUtils.js';
import { vapidPublicKey } from '../lib/webPush.js';
import { auth } from '../loaders/mainLoader.js';
import { stripDisallowedStatusFields } from '../schemas/operations/index.js';
import type { AuthVariables } from '../types/authTypes.js';
import { deviceSyncStateId, type EntitySnapshot, type EntityType, MAX_OP_ID, type OpType, type RsvpOpPayload } from '../types/entities.js';
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

// Deployed clients have shipped status transitions that leave a matrix-disallowed field on the
// snapshot (e.g. `expectedBy` surviving nextAction→calendar). Strict validation would 400 the
// whole batch and permanently jam the device's offline queue, so first-party sync strips the
// offending fields instead. `/v1` keeps the strict 400 — API callers get immediate feedback and
// have no queue to jam.
function sanitizeItemSnapshot<T extends Record<string, unknown>>(op: ClientOp, snapshot: T): T {
    if (op.entityType !== 'item' || (op.opType !== 'create' && op.opType !== 'update')) {
        return snapshot;
    }
    const { sanitized, strippedFields } = stripDisallowedStatusFields(snapshot);
    if (hasAtLeastOne(strippedFields)) {
        console.warn(`[sync-push] stripped status-disallowed field(s) from item ${op.entityId}: ${strippedFields.join(', ')}`);
    }
    // Width-only assertion: stripping removes keys, it never changes remaining value types.
    return sanitized as T;
}

async function purgeStaleDevices(userId: string): Promise<void> {
    const cutoffTs = dayjs().subtract(STALE_DEVICE_DAYS, 'day').toISOString();
    const { removedDeviceIds } = await reapStaleDevices(userId, cutoffTs);
    if (removedDeviceIds.length) {
        console.log(`[purge] removed ${removedDeviceIds.length} stale device(s) for user ${userId}: ${removedDeviceIds.join(', ')}`);
    }
}

async function purgeOldOperations(userId: string): Promise<void> {
    // Remove stale devices first so they no longer hold back the purge floor
    await purgeStaleDevices(userId);

    const deviceStates = await deviceSyncStateDAO.findArray({ user: userId });
    // Only purge ops all registered devices have already pulled — the slowest device sets the floor.
    // The compound (ts, _id) floor computation is shared with the on-demand maintenance endpoint.
    const floor = computePurgeFloor(deviceStates);
    if (!floor) return;

    await operationsDAO.deleteOlderThan(userId, floor.ts, floor.id);
}

/** True when a `deviceSyncState` row exists for this (device, user) pair — i.e. the device has bootstrapped and was not reaped. */
async function isDeviceRegistered(deviceId: string, userId: string): Promise<boolean> {
    const row = await deviceSyncStateDAO.findOne({ _id: deviceSyncStateId(deviceId, userId) });
    return row !== null;
}

/**
 * Records the (device, user) pull cursor on the EXISTING row only (`upsert: false`). Returns false
 * when no row matched — the row was reaped by a concurrent pull's stale-device sweep mid-request.
 * Callers must then answer 409 bootstrapRequired instead of the ops payload: re-creating the row
 * at the stale cursor would re-register the device inside a purge gap (the original data-loss bug).
 */
async function recordPullCursorOnExistingRow(deviceId: string, userId: string, cursor: { lastSyncedTs: string; lastSyncedId: string }): Promise<boolean> {
    const result = await deviceSyncStateDAO.updateOne(
        { _id: deviceSyncStateId(deviceId, userId) },
        { $set: { ...cursor, deviceId, user: userId } },
        { upsert: false },
    );
    return result.matchedCount > 0;
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
        // Client-derived display label ("Chrome on macOS") for the connected-devices list. Length-capped
        // server-side — it's a raw user-agent derivative, not a validated field.
        const deviceLabel = c.req.query('deviceLabel')?.trim().slice(0, 80);
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
            // lastSyncedId = MAX_OP_ID: the snapshot already holds every op at exactly serverTs, so
            // the compound floor (serverTs, MAX_OP_ID) honestly means "all ops ≤ serverTs delivered"
            // and the first incremental pull won't re-deliver them.
            // lastSeenTs: serverTs (in $set, not $setOnInsert) — a fresh row must not be born
            // half-stale at epoch (one quiet month from the reaper), and a returning device's
            // re-bootstrap is genuine activity worth refreshing on an existing row too.
            await deviceSyncStateDAO.updateOne(
                { _id: deviceSyncStateId(deviceId, user.id) },
                {
                    $set: {
                        lastSyncedTs: serverTs,
                        lastSyncedId: MAX_OP_ID,
                        deviceId,
                        user: user.id,
                        lastSeenTs: serverTs,
                        ...(deviceLabel ? { autoLabel: deviceLabel } : {}),
                    },
                },
                { upsert: true },
            );
        }

        return c.json({ items, routines, people, workContexts, serverTs, serverId: MAX_OP_ID });
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
            const snapshot = op.snapshot ? (sanitizeItemSnapshot(op, { ...snapshotFields, user: user.id }) as EntitySnapshot) : null;
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
        //
        // upsert: false — push must NEVER create or resurrect a device row; /sync/bootstrap is the
        // sole legitimate row creator. (a) The client flushes queued ops BEFORE pulling, so a reaped
        // device with a queue would resurrect its row here and mask the row-missing 409 on the
        // following pull — the silent purge-gap data loss would return. (b) A resurrected
        // $setOnInsert row would sit at an epoch cursor, re-pinning the purge floor to epoch — and
        // the Service-Worker background-sync flush pushes with NO subsequent pull, so that stall
        // could persist indefinitely rather than just until the next foreground sync.
        await deviceSyncStateDAO.updateOne(
            { _id: deviceSyncStateId(deviceId, user.id) },
            { $set: { lastSeenTs: now, deviceId, user: user.id } },
            { upsert: false },
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
        // Compound-cursor id components. Missing (old clients) → '' (lowest id), which makes the
        // pull query re-check the whole boundary ms and the cursor write land at the start of it —
        // safe re-delivery, never a skip. See operationsDAO.findOpsAfter.
        const sinceId = c.req.query('sinceId') ?? '';
        const ackedId = c.req.query('ackedId');
        const deviceId = c.req.query('deviceId');

        // Reaped-device guard — BEFORE any read or write. Invariant: ops are only purged
        // at-or-below the floor = min acked cursor over REGISTERED rows, so a device whose row
        // exists can never be inside a purge gap. The only way into a gap is having your row
        // reaped while offline; genuinely-new devices bootstrap client-side and never hit /pull.
        // Short-circuiting before the cursor write below is load-bearing: re-registering the row
        // at its stale cursor would put the device right back inside the gap (silent data loss).
        if (deviceId && !(await isDeviceRegistered(deviceId, user.id))) {
            return c.json({ bootstrapRequired: true }, 409);
        }

        const ops = await operationsDAO.findOpsAfter(user.id, since, sinceId);

        // `serverTs`/`serverId` mark the high-water mark of *what we just returned* — the client uses
        // the pair as the next pull's `(since, sinceId)`. Paginating on the totally-ordered `(ts,_id)`
        // pair (rather than a bare ms) means a same-`ts` batch split across two pulls loses nothing:
        // the next pull resumes strictly after `lastOp._id`. Empty-ops → echo the incoming cursor.
        const lastOp = ops.at(-1);
        const serverTs = lastOp ? lastOp.ts : since;
        const serverId = lastOp ? lastOp._id : sinceId;

        if (deviceId) {
            // Track per-(device, user) pull cursor so old operations can eventually be purged.
            // Composite _id keeps each user's cursor independent — see DeviceSyncStateInterface.
            // We record `ackedTs`/`ackedId` (what the client claims it has durably persisted) rather
            // than `serverTs`/`serverId` (what we're about to return): a lost/partial response must
            // not advance the purge floor past ops the client never committed. Old clients send
            // neither — `ackedId ?? sinceId` resolves to '' so their floor sits at the start of the
            // boundary ms, keeping every same-ms op until they upgrade.
            const rowStillExists = await recordPullCursorOnExistingRow(deviceId, user.id, {
                lastSyncedTs: ackedTs ?? since,
                lastSyncedId: ackedId ?? sinceId,
            });
            // Mid-request reap race: a concurrent pull's stale-device sweep removed the row between
            // the top-of-handler registration check and this write. Return 409 INSTEAD of the ops
            // payload — the client must discard this response and bootstrap.
            if (!rowStillExists) {
                return c.json({ bootstrapRequired: true }, 409);
            }

            // Fire-and-forget: purge ops all (device, user) rows have already seen to cap storage growth.
            // Async so the pull response isn't blocked by the deletion query.
            purgeOldOperations(user.id).catch(() => {});
        }

        return c.json({ ops, serverTs, serverId });
    })

    // ---------------------------------------------------------------------------
    // GET /sync/device-status?deviceId=  — probe-before-flush registration check
    // ---------------------------------------------------------------------------
    // The client calls this BEFORE auto-flushing queued offline ops: a reaped device's user must
    // get to choose push-vs-discard in the recovery dialog before anything is sent. Discovering
    // the reap only via the pull 409 would be too late — the queue auto-flushes ahead of the pull.
    .get('/device-status', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const deviceId = c.req.query('deviceId');
        if (!deviceId) {
            return c.json({ error: 'deviceId query param required' }, 400);
        }
        return c.json({ registered: await isDeviceRegistered(deviceId, user.id) });
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
                // Cache-Control is set globally to `no-store` by noStoreCache() (index.ts) — stronger
                // than the `no-cache` this endpoint used to set, so it is intentionally omitted here.
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
            // Surface the orchestrator's structured `code` (today: only set for `validation_failed`,
            // which now includes person/workContext entityType rejections) so the in-app caller can
            // discriminate validation failures from generic 4xx without parsing the message string.
            return c.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, result.status);
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
