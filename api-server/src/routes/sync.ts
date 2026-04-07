import dayjs from 'dayjs';
import { Hono } from 'hono';
import { authenticateRequest } from '../auth/middleware.js';
import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import type AbstractDAO from '../dataAccess/abstractDAO.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import deviceSyncStateDAO from '../dataAccess/deviceSyncStateDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import peopleDAO from '../dataAccess/peopleDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import workContextsDAO from '../dataAccess/workContextsDAO.js';
import { maybePushToGCal } from '../lib/calendarPushback.js';
import { addSseConnection, notifyUserViaSse, removeSseConnection } from '../lib/sseConnections.js';
import { notifyViaWebPush, vapidPublicKey } from '../lib/webPush.js';
import type { AuthVariables } from '../types/authTypes.js';
import type {
    CalendarIntegrationInterface,
    EntitySnapshot,
    EntityType,
    ItemInterface,
    OperationInterface,
    OpType,
    PersonInterface,
    RoutineInterface,
    WorkContextInterface,
} from '../types/entities.js';

// Shape of each operation as sent by the client — mirrors the client SyncOperation type.
// Snapshot uses `userId` (IndexedDB field name); the server remaps it to `user`.
interface ClientOp {
    entityType: EntityType;
    entityId: string;
    opType: OpType;
    queuedAt: string;
    snapshot: (Record<string, unknown> & { userId?: string }) | null;
}

/** Creates a GoogleCalendarProvider that persists refreshed tokens back to MongoDB. */
function buildCalendarProvider(integration: CalendarIntegrationInterface, userId: string): GoogleCalendarProvider {
    return new GoogleCalendarProvider(integration, (accessToken, refreshToken, expiry) =>
        calendarIntegrationsDAO.updateTokens({ id: integration._id, userId, accessToken, refreshToken, tokenExpiry: expiry }),
    );
}

// Single generic helper replacing four near-identical applyXxxOp functions.
// The DAO provides deleteByOwner / findByOwnerAndId / replaceById; the only
// varying pieces are the DAO instance and the snapshot type.
async function applyEntitySnapshotOp<T extends EntitySnapshot>(
    dao: AbstractDAO<T>,
    userId: string,
    entityId: string,
    opType: OpType,
    snapshot: T | null,
): Promise<void> {
    if (opType === 'delete') {
        // userId guard ensures a user can never delete another user's entity via a crafted op
        await dao.deleteByOwner(entityId, userId);
        return;
    }
    if (!snapshot) {
        return;
    }

    // Two-step last-write-wins: fetch current then replace only if incoming is newer or equal.
    // Simpler than a conditional upsert query; safe for the low-throughput GTD use case.
    const existing = await dao.findByOwnerAndId(entityId, userId);
    if (!existing || existing.updatedTs <= snapshot.updatedTs) {
        await dao.replaceById(entityId, snapshot);
    }
}

function applyEntityOp(userId: string, op: OperationInterface): Promise<void> {
    const { entityType, entityId, opType, snapshot } = op;
    switch (entityType) {
        case 'item':
            return applyEntitySnapshotOp(itemsDAO, userId, entityId, opType, snapshot as ItemInterface | null);
        case 'routine':
            return applyEntitySnapshotOp(routinesDAO, userId, entityId, opType, snapshot as RoutineInterface | null);
        case 'person':
            return applyEntitySnapshotOp(peopleDAO, userId, entityId, opType, snapshot as PersonInterface | null);
        case 'workContext':
            return applyEntitySnapshotOp(workContextsDAO, userId, entityId, opType, snapshot as WorkContextInterface | null);
    }
}

async function purgeOldOperations(userId: string): Promise<void> {
    const deviceStates = await deviceSyncStateDAO.findArray({ user: userId });
    if (!deviceStates.length) {
        return;
    }

    // Only purge ops all registered devices have already pulled — the slowest device sets the floor.
    // reduce without an initial value uses the first element as the accumulator seed; TypeScript
    // types this as returning the element type (not T | undefined), safe since we guard length above.
    const minLastSyncedTs = deviceStates.map((d) => d.lastSyncedTs).reduce((min, ts) => (ts < min ? ts : min));

    await operationsDAO.deleteOlderThan(userId, minLastSyncedTs);
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

        const [items, routines, people, workContexts] = await Promise.all([
            itemsDAO.findArray({ user: user.id }),
            routinesDAO.findArray({ user: user.id }),
            peopleDAO.findArray({ user: user.id }),
            workContextsDAO.findArray({ user: user.id }),
        ]);

        return c.json({ items, routines, people, workContexts, serverTs: dayjs().toISOString() });
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

        const now = dayjs().toISOString();

        const serverOps = ops.map<OperationInterface>((op) => {
            // Strip client-side `userId` and inject server-authoritative `user` from session
            const { userId: _stripped, ...snapshotFields } = op.snapshot ?? {};
            const snapshot = op.snapshot ? ({ ...snapshotFields, user: user.id } as EntitySnapshot) : null;
            return {
                _id: crypto.randomUUID(),
                user: user.id,
                deviceId,
                ts: now,
                entityType: op.entityType,
                entityId: op.entityId,
                opType: op.opType,
                snapshot,
            };
        });

        await Promise.all([operationsDAO.insertMany(serverOps), ...serverOps.map((op) => applyEntityOp(user.id, op))]);

        // Push calendar-relevant changes back to Google Calendar (fire-and-forget).
        // Runs after applyEntityOp so the DB state is consistent when the push-back reads it.
        void Promise.all(serverOps.map((op) => maybePushToGCal(op, buildCalendarProvider))).catch((err) => {
            console.error('[calendar-pushback] failed:', err);
        });

        await deviceSyncStateDAO.updateOne(
            { _id: deviceId },
            { $set: { lastSeenTs: now, user: user.id }, $setOnInsert: { lastSyncedTs: dayjs(0).toISOString() } },
            { upsert: true },
        );

        notifyUserViaSse(user.id, { type: 'update', ts: now });

        // Web Push for devices that aren't currently connected via SSE (app closed).
        // Include per-op summaries so the SW can show a meaningful notification body
        // (e.g. "Updated: Call dentist") instead of a generic message.
        await notifyViaWebPush(user.id, deviceId, serverOps, now);

        return c.json({ ok: true }, 200);
    })

    // ---------------------------------------------------------------------------
    // GET /sync/pull  — client fetches operations it hasn't seen yet
    // ---------------------------------------------------------------------------
    .get('/pull', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const since = c.req.query('since') ?? dayjs(0).toISOString();
        const deviceId = c.req.query('deviceId');

        const ops = await operationsDAO.findArray({ user: user.id, ts: { $gt: since } }, { sort: { ts: 1 } });

        // Advance the cursor to exactly the last returned op's ts, or keep it at `since`
        // when nothing is returned. Using dayjs() here would race with concurrent pushes:
        // a push could commit ops with ts < dayjs() that the query above didn't see,
        // causing the client to advance its cursor past ops it never received.
        // Known limitation: if another push commits ops at exactly `lastOp.ts` after this
        // query ran, the next pull ($gt: lastOp.ts) will miss them. Acceptable for the
        // low-throughput GTD use case; a monotonic sequence would eliminate the gap.
        const lastOp = ops.at(-1);
        const serverTs = lastOp ? lastOp.ts : since;

        if (deviceId) {
            // Track per-device pull cursor so old operations can eventually be purged
            await deviceSyncStateDAO.updateOne(
                { _id: deviceId },
                { $set: { lastSyncedTs: serverTs, user: user.id }, $setOnInsert: { lastSeenTs: dayjs(0).toISOString() } },
                { upsert: true },
            );

            // Fire-and-forget: purge ops all devices have already seen to cap storage growth.
            // Async so the pull response isn't blocked by the deletion query.
            purgeOldOperations(user.id).catch(() => {});
        }

        return c.json({ ops, serverTs });
    })

    // ---------------------------------------------------------------------------
    // GET /events  — SSE stream; server pushes { type: 'update', ts } on changes
    // ---------------------------------------------------------------------------
    .get('/events', authenticateRequest, async (c) => {
        const { user } = c.get('session');

        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                addSseConnection(user.id, controller);

                // Initial comment keeps the connection open and confirms it's alive to the client
                controller.enqueue(new TextEncoder().encode(': connected\n\n'));

                // Remove from map when client disconnects; EventSource will auto-reconnect
                c.req.raw.signal.addEventListener('abort', () => {
                    removeSseConnection(user.id, controller);
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
    .get('/config', (c) => c.json({ vapidPublicKey }));
