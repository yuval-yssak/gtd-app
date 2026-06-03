/** biome-ignore-all lint/style/noNonNullAssertion: tests assert preconditions before using ! */
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { syncRoutes } from '../routes/sync.js';
import type { EntityType, OpType } from '../types/entities.js';
import { authenticatedRequest, oauthLogin, SESSION_COOKIE } from './helpers.js';

// `/sync/push` flips to strict-mode validation in Phase 1 step 10. A bad op rejects the whole
// batch with HTTP 400 + structured error payload — no partial application.
const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/sync', syncRoutes);

beforeAll(async () => {
    await loadDataAccess('gtd_test_push_validation');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([
        db.collection('user').deleteMany({}),
        db.collection('session').deleteMany({}),
        db.collection('account').deleteMany({}),
        db.collection('items').deleteMany({}),
        db.collection('routines').deleteMany({}),
        db.collection('operations').deleteMany({}),
        db.collection('webhookSubscriptions').deleteMany({}),
        db.collection('webhookDeliveries').deleteMany({}),
    ]);
    vi.restoreAllMocks();
});

function makeClientOp(entityType: EntityType, entityId: string, opType: OpType, snapshot: Record<string, unknown> | null) {
    return { entityType, entityId, opType, queuedAt: dayjs().toISOString(), snapshot };
}

async function getUserId(sessionCookie: string): Promise<string> {
    const res = await app.fetch(
        new Request('http://localhost:4000/auth/get-session', {
            headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
        }),
    );
    const { user } = (await res.json()) as { user: { id: string } };
    return user.id;
}

async function push(sessionCookie: string, deviceId: string, ops: ReturnType<typeof makeClientOp>[]) {
    return authenticatedRequest(app, { method: 'POST', path: '/sync/push', sessionCookie, body: { deviceId, ops } });
}

describe('POST /sync/push — strict-mode validation', () => {
    it('400 with status_field_violation when an op carries ignoreBefore on a calendar item', async () => {
        const { sessionCookie } = await oauthLogin(app, 'google');
        const userId = await getUserId(sessionCookie!);
        const entityId = crypto.randomUUID();

        const res = await push(sessionCookie!, 'dev-1', [
            makeClientOp('item', entityId, 'create', {
                _id: entityId,
                user: userId,
                userId,
                status: 'calendar',
                title: 'meeting',
                timeStart: '2026-05-09T10:00:00Z',
                timeEnd: '2026-05-09T11:00:00Z',
                ignoreBefore: '2026-05-08',
                createdTs: '2026-05-08T10:00:00Z',
                updatedTs: '2026-05-08T10:00:00Z',
            }),
        ]);

        expect(res.status).toBe(400);
        const body = (await res.json()) as { code: string; extra?: { field?: string; status?: string } };
        expect(body.code).toBe('status_field_violation');
        expect(body.extra?.field).toBe('ignoreBefore');
        expect(body.extra?.status).toBe('calendar');

        // Strict mode aborts the whole batch — nothing should have been persisted.
        expect(await db.collection('items').countDocuments()).toBe(0);
        expect(await db.collection('operations').countDocuments()).toBe(0);
    });

    it('400 with invalid_operation when an op snapshot is malformed (missing required field)', async () => {
        const { sessionCookie } = await oauthLogin(app, 'google');
        const userId = await getUserId(sessionCookie!);
        const entityId = crypto.randomUUID();

        const res = await push(sessionCookie!, 'dev-1', [
            makeClientOp('item', entityId, 'create', {
                _id: entityId,
                user: userId,
                userId,
                status: 'inbox',
                title: 'no-createdTs',
                // createdTs missing on purpose — required by the schema
                updatedTs: '2026-05-08T10:00:00Z',
            }),
        ]);

        expect(res.status).toBe(400);
        const body = (await res.json()) as { code: string };
        expect(body.code).toBe('invalid_operation');
    });

    it('200 + persists when all ops are conformant', async () => {
        const { sessionCookie } = await oauthLogin(app, 'google');
        const userId = await getUserId(sessionCookie!);
        const entityId = crypto.randomUUID();

        const res = await push(sessionCookie!, 'dev-1', [
            makeClientOp('item', entityId, 'create', {
                _id: entityId,
                user: userId,
                userId,
                status: 'inbox',
                title: 'ok',
                createdTs: '2026-05-08T10:00:00Z',
                updatedTs: '2026-05-08T10:00:00Z',
            }),
        ]);

        expect(res.status).toBe(200);
        expect(await db.collection('items').countDocuments({ _id: entityId })).toBe(1);
    });

    it('rejects whole batch atomically: a single bad op aborts everything, even if siblings are fine', async () => {
        const { sessionCookie } = await oauthLogin(app, 'google');
        const userId = await getUserId(sessionCookie!);
        const goodId = crypto.randomUUID();
        const badId = crypto.randomUUID();

        const res = await push(sessionCookie!, 'dev-1', [
            makeClientOp('item', goodId, 'create', {
                _id: goodId,
                user: userId,
                userId,
                status: 'inbox',
                title: 'good',
                createdTs: '2026-05-08T10:00:00Z',
                updatedTs: '2026-05-08T10:00:00Z',
            }),
            makeClientOp('item', badId, 'create', {
                _id: badId,
                user: userId,
                userId,
                status: 'calendar',
                title: 'bad',
                timeStart: '2026-05-09T10:00:00Z',
                timeEnd: '2026-05-09T11:00:00Z',
                ignoreBefore: '2026-05-08',
                createdTs: '2026-05-08T10:00:00Z',
                updatedTs: '2026-05-08T10:00:00Z',
            }),
        ]);

        expect(res.status).toBe(400);
        // Neither item should be persisted. Strict-mode contract: validate-all-then-apply.
        expect(await db.collection('items').countDocuments()).toBe(0);
        expect(await db.collection('operations').countDocuments()).toBe(0);
    });

    it('floating-wall-clock timeStart/timeEnd is accepted (matches routine generator output)', async () => {
        const { sessionCookie } = await oauthLogin(app, 'google');
        const userId = await getUserId(sessionCookie!);
        const entityId = crypto.randomUUID();

        const res = await push(sessionCookie!, 'dev-1', [
            makeClientOp('item', entityId, 'create', {
                _id: entityId,
                user: userId,
                userId,
                status: 'calendar',
                title: 'wall-clock',
                timeStart: '2026-07-07T10:45:00',
                timeEnd: '2026-07-07T11:00:00',
                createdTs: '2026-05-08T10:00:00Z',
                updatedTs: '2026-05-08T10:00:00Z',
            }),
        ]);

        expect(res.status).toBe(200);
        const stored = await db.collection<{ timeStart: string }>('items').findOne({ _id: entityId } as never);
        expect(stored?.timeStart).toBe('2026-07-07T10:45:00');
    });

    it('200 + persists when a calendar item update op carries meetingLink/location/htmlLink', async () => {
        // These GCal-owned fields round-trip through /sync/push when the client re-edits a synced
        // calendar item (e.g. a drag). The strict ItemSnapshotSchema must accept them, else the whole
        // batch 400s — the documented fromGmail-style regression.
        const { sessionCookie } = await oauthLogin(app, 'google');
        const userId = await getUserId(sessionCookie!);
        const entityId = crypto.randomUUID();

        const res = await push(sessionCookie!, 'dev-1', [
            makeClientOp('item', entityId, 'create', {
                _id: entityId,
                user: userId,
                userId,
                status: 'calendar',
                title: 'standup',
                timeStart: '2026-07-08T09:00:00Z',
                timeEnd: '2026-07-08T09:15:00Z',
                meetingLink: 'https://meet.google.com/abc-defg-hij',
                location: 'Room 4B',
                htmlLink: 'https://calendar.google.com/event?eid=abc123',
                createdTs: '2026-05-08T10:00:00Z',
                updatedTs: '2026-05-08T10:00:00Z',
            }),
        ]);

        expect(res.status).toBe(200);
        const stored = await db.collection<{ meetingLink: string; location: string; htmlLink: string }>('items').findOne({ _id: entityId } as never);
        expect(stored?.meetingLink).toBe('https://meet.google.com/abc-defg-hij');
        expect(stored?.location).toBe('Room 4B');
        expect(stored?.htmlLink).toBe('https://calendar.google.com/event?eid=abc123');
    });
});

// Plan-mandated contract change: webhooks now fire for `/sync/push`-driven ops too, not just
// `/v1/*`. `mapOpToEvents` only maps inbox creates and done updates today, so that's the bound.
describe('POST /sync/push — webhook fan-out', () => {
    it('enqueues a webhook delivery for an inbox-create op pushed via /sync/push', async () => {
        const { sessionCookie } = await oauthLogin(app, 'google');
        const userId = await getUserId(sessionCookie!);

        await db.collection('webhookSubscriptions').insertOne({
            _id: 'sub-sync-push',
            user: userId,
            url: 'https://example.test/hook',
            events: ['item.created'],
            secret: 's-1',
            createdTs: '2026-05-08T10:00:00Z',
        } as never);

        const entityId = crypto.randomUUID();
        const res = await push(sessionCookie!, 'dev-1', [
            makeClientOp('item', entityId, 'create', {
                _id: entityId,
                user: userId,
                userId,
                status: 'inbox',
                title: 'webhook me',
                createdTs: '2026-05-08T10:00:00Z',
                updatedTs: '2026-05-08T10:00:00Z',
            }),
        ]);
        expect(res.status).toBe(200);

        // notifyChanges enqueues fire-and-forget; poll briefly for the delivery row.
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline) {
            const count = await db.collection('webhookDeliveries').countDocuments({ subscriptionId: 'sub-sync-push' });
            if (count >= 1) break;
            await new Promise<void>((r) => setTimeout(r, 20));
        }
        const count = await db.collection('webhookDeliveries').countDocuments({ subscriptionId: 'sub-sync-push' });
        expect(count).toBeGreaterThanOrEqual(1);
    });
});
