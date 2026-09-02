import dayjs from 'dayjs';
import { Hono } from 'hono';
import { authenticateRequest } from '../auth/middleware.js';
import deviceSyncStateDAO from '../dataAccess/deviceSyncStateDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import peopleDAO from '../dataAccess/peopleDAO.js';
import reviewInboxesDAO from '../dataAccess/reviewInboxesDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import workContextsDAO from '../dataAccess/workContextsDAO.js';
import { isDuplicateKeyError } from '../lib/applyEntityOp.js';
import { applyAndPublishOperations, OperationValidationError, type RawOperation } from '../lib/applyOperation.js';
import { computePurgeFloor, STALE_DEVICE_DAYS } from '../lib/purgeFloor.js';
import { type ReassignParams, reassignEntity } from '../lib/reassignEntity.js';
import { addSseConnection, notifyUserViaSse, removeSseConnection } from '../lib/sseConnections.js';
import { reapStaleDevices } from '../lib/staleDevices.js';
import { hasAtLeastOne } from '../lib/typeUtils.js';
import { isValidIanaTimezone } from '../lib/userTimezone.js';
import { vapidPublicKey } from '../lib/webPush.js';
import { auth } from '../loaders/mainLoader.js';
import { stripDisallowedStatusFields } from '../schemas/operations/index.js';
import type { AuthVariables } from '../types/authTypes.js';
import { type DeviceSyncStateInterface, deviceSyncStateId, type EntitySnapshot, type EntityType, type OpType, type RsvpOpPayload } from '../types/entities.js';
import { syncIssuesRoutes } from './syncIssues.js';

// Shape of each operation as sent by the client — mirrors the client SyncOperation type.
// Snapshot uses `userId` (IndexedDB field name); the server remaps it to `user`.
interface ClientOp {
    entityType: EntityType;
    entityId: string;
    opType: OpType;
    queuedAt: string;
    /**
     * Owner tag from the client's IDB sync queue. The misroute guard falls back to it for
     * `snapshot: null` (delete) ops, which carry no `snapshot.userId` — without this fallback a
     * background flush under a drifted cookie session could delete another user's entity silently.
     */
    userId?: string;
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

/**
 * How far behind the wall clock the advertised pull/bootstrap cursor is held. Op `(ts, _id)`
 * identities are allocated at write time (see lib/opIdentity.ts), but allocation and the Mongo
 * commit are not atomic: a concurrently-built batch, an event-loop stall, or cross-instance clock
 * skew can land an op in the collection AFTER a pull has already read past its `ts`. Because the
 * client cursor is strictly forward-only, that op would be permanently skipped. Holding the
 * advertised cursor this far back means every op committed within the window is re-checked by the
 * next pull — re-delivery is idempotent (LWW snapshots), losing an op is not. Five seconds
 * comfortably covers commit lag and NTP-level skew without meaningfully growing pull payloads.
 */
const CURSOR_HOLDBACK_SECONDS = 5;

/**
 * Read per-call so tests exercising purge/floor mechanics can zero the window (a real 5s wait per
 * assertion would balloon the suite). Production never sets the env var. Guarded against `''`
 * (`Number('') === 0` would silently disable the holdback) and negative values (a negative
 * subtract advertises a FUTURE boundary, skipping every op inside it — worse than no holdback).
 */
function cursorHoldbackSeconds(): number {
    const raw = process.env.SYNC_CURSOR_HOLDBACK_SECONDS;
    if (raw === undefined || raw.trim() === '') {
        return CURSOR_HOLDBACK_SECONDS;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : CURSOR_HOLDBACK_SECONDS;
}

/** The compound cursor boundary `(ts, id)` the server is willing to advertise right now. */
function cursorHoldbackBoundary(): { ts: string; id: string } {
    // id '' sorts below every op id, so a cursor at the boundary re-checks the whole boundary ms.
    return { ts: dayjs().subtract(cursorHoldbackSeconds(), 'second').toISOString(), id: '' };
}

/** Strict `>` over the compound `(ts, id)` op-cursor order shared by pull, bootstrap, and purge. */
function isCursorAfter(a: { ts: string; id: string }, b: { ts: string; id: string }): boolean {
    return a.ts > b.ts || (a.ts === b.ts && a.id > b.id);
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
async function recordPullCursorOnExistingRow(
    deviceId: string,
    userId: string,
    cursor: { lastSyncedTs: string; lastSyncedId: string },
    timezone?: string,
): Promise<boolean> {
    const result = await deviceSyncStateDAO.updateOne(
        { _id: deviceSyncStateId(deviceId, userId) },
        { $set: { ...cursor, deviceId, user: userId, ...timezoneReportFields(timezone) } },
        { upsert: false },
    );
    return result.matchedCount > 0;
}

/**
 * `$set` fragment recording a device's timezone report. Empty when the report is absent or not a
 * real IANA name (raw client-supplied param) — an invalid report must not erase a prior good one.
 * Bootstrap and pull are the only report sites; /sync/push deliberately isn't one (a Service
 * Worker background flush can push without pulling, but the next foreground pull refreshes it).
 */
function timezoneReportFields(timezone: string | undefined): Partial<DeviceSyncStateInterface> {
    if (!timezone || !isValidIanaTimezone(timezone)) {
        return {};
    }
    return { timezone, timezoneReportedTs: dayjs().toISOString() };
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
        const timezone = c.req.query('timezone');
        // One boundary for both the response body and the deviceSyncState row, so the recorded
        // floor exactly matches what the client claims it has after consuming this response.
        // Held back CURSOR_HOLDBACK_SECONDS: an op whose identity was allocated just before this
        // read but whose insert commits just after it would land behind a wall-clock cursor and
        // never reach this device (the bootstrap-vs-concurrent-import race). Starting the cursor
        // inside the holdback window re-delivers the last few seconds of ops on the first pull —
        // idempotent against the snapshot the response already carries.
        // A RE-bootstrapping device (409 recovery, account switch) keeps its existing cursor when
        // that is already ahead of the held-back boundary: the snapshot is a superset of anything
        // the device acked, so the higher cursor stays honest — while rewinding it would drag the
        // user's purge floor backwards and re-deliver a window the device provably consumed.
        const heldBack = cursorHoldbackBoundary();
        const existingRow = deviceId ? await deviceSyncStateDAO.findOne({ _id: deviceSyncStateId(deviceId, user.id) }) : null;
        const existingCursor = existingRow ? { ts: existingRow.lastSyncedTs, id: existingRow.lastSyncedId ?? '' } : null;
        const bootstrapCursor = existingCursor && isCursorAfter(existingCursor, heldBack) ? existingCursor : heldBack;
        const serverTs = bootstrapCursor.ts;

        const [items, routines, people, workContexts, reviewInboxes] = await Promise.all([
            itemsDAO.findArray({ user: user.id }),
            routinesDAO.findArray({ user: user.id }),
            peopleDAO.findArray({ user: user.id }),
            workContextsDAO.findArray({ user: user.id }),
            reviewInboxesDAO.findArray({ user: user.id }),
        ]);

        // Register the device as soon as we've decided what's in the response. Bootstrap delivers
        // a full snapshot — by the time `fetchBootstrap` resolves on the client, IndexedDB will
        // hold everything ≤ serverTs, so writing `lastSyncedTs: serverTs` is honest. We await
        // the upsert so a sibling device that pulls before this device's first incremental pull
        // can't drop the purge floor through the missing row (its pull would have computed
        // `min(lastSyncedTs)` excluding this device, potentially deleting ops this device needs).
        if (deviceId) {
            // lastSyncedId = '' (sorts below every op id): the first incremental pull re-checks the
            // whole boundary millisecond, so a same-ms op that committed after the snapshot read is
            // re-delivered rather than skipped. Ops the snapshot already covered re-apply
            // idempotently.
            // lastSeenTs: dayjs() (in $set, not $setOnInsert) — a fresh row must not be born
            // half-stale at epoch (one quiet month from the reaper), and a returning device's
            // re-bootstrap is genuine activity worth refreshing on an existing row too.
            await deviceSyncStateDAO.updateOne(
                { _id: deviceSyncStateId(deviceId, user.id) },
                {
                    $set: {
                        lastSyncedTs: serverTs,
                        lastSyncedId: bootstrapCursor.id,
                        deviceId,
                        user: user.id,
                        lastSeenTs: dayjs().toISOString(),
                        ...(deviceLabel ? { autoLabel: deviceLabel } : {}),
                        ...timezoneReportFields(timezone),
                    },
                },
                { upsert: true },
            );
        }

        return c.json({ items, routines, people, workContexts, reviewInboxes, serverTs, serverId: bootstrapCursor.id });
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
        // active session before flushing. If an op carries a userId tag that disagrees with the
        // session, the previous flow would silently overwrite and corrupt data (the bug that put
        // item ebd197ea-… under the wrong user). Fail loudly instead.
        // We check `snapshot.userId` (IndexedDB field name) first — server entities use `user`,
        // but the client's remapUser stamps the IDB-style `userId` onto outbound op snapshots —
        // and fall back to the op-level `userId` tag from the client's sync queue. The fallback
        // is what catches `snapshot: null` (delete) ops: they have no snapshot tag, and with the
        // local-first account switch the cookie session can legitimately lag IDB, so "trust the
        // session" is no longer a safe default for deletes.
        const mismatched = ops.find((op) => {
            const taggedUserId = op.snapshot?.userId ?? op.userId;
            return taggedUserId !== undefined && taggedUserId !== user.id;
        });
        if (mismatched) {
            return c.json(
                {
                    error: `Op userId mismatch: ${mismatched.opType}:${mismatched.entityType}:${mismatched.entityId} tagged userId=${mismatched.snapshot?.userId ?? mismatched.userId} but session user.id=${user.id}. Use syncAllLoggedInUsers/syncOneUser for cross-account flushes.`,
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
            // A unique-index violation is a permanent property of THIS batch, not a transient
            // server fault. Returning 500 makes the client retry the identical batch forever
            // (the 2026-08-03 stuck-sync incident: sync dead until the op was hand-deleted).
            // 400 routes it into the client's sync-recovery flow (push-vs-discard) instead.
            if (isDuplicateKeyError(err)) {
                console.warn('[sync-push] duplicate-key rejection mapped to 400', err);
                return c.json({ error: 'A snapshot in this batch claims a unique key owned by another entity.', code: 'duplicate_key' }, 400);
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

        // `serverTs`/`serverId` mark the cursor the client should pull from next. Normally that is
        // the high-water mark of what we just returned — paginating on the totally-ordered `(ts,_id)`
        // pair means a same-`ts` batch split across two pulls loses nothing. Two clamps apply:
        //  - Never advance INTO the holdback window: an op committed late (build→insert gap,
        //    cross-instance clock skew) inside that window would otherwise land behind the
        //    forward-only cursor and be skipped forever. Fresh ops are still RETURNED — they are
        //    just re-checked by the next pull, which is idempotent.
        //  - Never advertise BELOW the incoming cursor: a client already past the holdback boundary
        //    (legacy wall-clock bootstrap row, cross-instance skew) must get its own cursor echoed
        //    back, not a lower one its forward-only guard would reject on every pull.
        // An empty pull may still advance the cursor up to the holdback boundary: ops can no longer
        // commit with a `ts` older than that (write-time identity + holdback bound the lag), so the
        // scanned-and-empty range is provably final and skipping it forward is safe.
        const lastOp = ops.at(-1);
        const holdback = cursorHoldbackBoundary();
        const incoming = { ts: since, id: sinceId };
        const heldBackHighWater =
            lastOp === undefined || isCursorAfter({ ts: lastOp.ts, id: lastOp._id }, holdback) ? holdback : { ts: lastOp.ts, id: lastOp._id };
        const boundary = isCursorAfter(heldBackHighWater, incoming) ? heldBackHighWater : incoming;
        const serverTs = boundary.ts;
        const serverId = boundary.id;

        if (deviceId) {
            // Track per-(device, user) pull cursor so old operations can eventually be purged.
            // Composite _id keeps each user's cursor independent — see DeviceSyncStateInterface.
            // We record `ackedTs`/`ackedId` (what the client claims it has durably persisted) rather
            // than `serverTs`/`serverId` (what we're about to return): a lost/partial response must
            // not advance the purge floor past ops the client never committed. Old clients send
            // neither — `ackedId ?? sinceId` resolves to '' so their floor sits at the start of the
            // boundary ms, keeping every same-ms op until they upgrade.
            const rowStillExists = await recordPullCursorOnExistingRow(
                deviceId,
                user.id,
                {
                    lastSyncedTs: ackedTs ?? since,
                    lastSyncedId: ackedId ?? sinceId,
                },
                c.req.query('timezone'),
            );
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
    // The move itself is an atomic owner flip; GCal side effects are op-driven and asynchronous
    // (the target event appears seconds after the move). Retries of a completed move succeed with
    // `alreadyMoved: true` instead of a 404.
    .post('/reassign', authenticateRequest, async (c) => {
        const params = await c.req.json<ReassignParams>();
        const guard = await validateReassignSessions(c.req.raw.headers, params);
        if (!guard.ok) {
            return c.json({ error: guard.error }, guard.status);
        }
        const result = await reassignEntity(params);
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
        return c.json({ ok: true, ...(result.alreadyMoved ? { alreadyMoved: true } : {}) }, 200);
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
