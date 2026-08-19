import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { syncRoutes } from '../routes/sync.js';
import type {
    CalendarIntegrationInterface,
    CalendarSyncConfigInterface,
    ItemInterface,
    OperationInterface,
    OpFailureReason,
    RoutineInterface,
} from '../types/entities.js';
import { authenticatedRequest, oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/sync', syncRoutes);

// ─── Lifecycle ──────────────────────────────────────────────────────────────

beforeAll(async () => {
    await loadDataAccess('gtd_test_sync_issues');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([
        db.collection('user').deleteMany({}),
        db.collection('session').deleteMany({}),
        db.collection('account').deleteMany({}),
        db.collection('verification').deleteMany({}),
        db.collection('items').deleteMany({}),
        db.collection('routines').deleteMany({}),
        db.collection('operations').deleteMany({}),
        db.collection('calendarIntegrations').deleteMany({}),
        db.collection('calendarSyncConfigs').deleteMany({}),
    ]);
    vi.restoreAllMocks();
    // Avoid live network call when retry triggers resolvePushContext on a calendar item.
    vi.spyOn(GoogleCalendarProvider.prototype, 'getCalendarTimeZone').mockResolvedValue('Asia/Jerusalem');
});

// ─── Helpers ────────────────────────────────────────────────────────────────

async function loginAsAlice(): Promise<string> {
    const { sessionCookie } = await oauthLogin(app, 'google');
    if (!sessionCookie) throw new Error('missing session cookie for Alice');
    return sessionCookie;
}

async function loginAsBob(): Promise<string> {
    // Use GitHub so Bob's account is distinct from Alice's Google identity.
    const { sessionCookie } = await oauthLogin(app, 'github', { email: 'bob@example.com', login: 'bob-gh' });
    if (!sessionCookie) throw new Error('missing session cookie for Bob');
    return sessionCookie;
}

async function getUserId(sessionCookie: string): Promise<string> {
    const res = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
    const { user } = (await res.json()) as { user: { id: string } };
    return user.id;
}

function makeFailedOp(userId: string, overrides: Partial<OperationInterface> & { failureReason: OpFailureReason }): OperationInterface {
    const now = dayjs().toISOString();
    const baseId = `op-${crypto.randomUUID()}`;
    return {
        _id: baseId,
        user: userId,
        deviceId: 'dev-1',
        ts: now,
        entityType: 'item',
        entityId: `item-${crypto.randomUUID()}`,
        opType: 'rsvp',
        snapshot: null,
        syncFailed: true,
        failureDetail: 'mocked detail',
        failedTs: now,
        ...overrides,
    };
}

function makeIntegration(userId: string): CalendarIntegrationInterface {
    const now = dayjs().toISOString();
    return {
        _id: 'int-issues',
        user: userId,
        provider: 'google',
        accessToken: 'at',
        refreshToken: 'rt',
        tokenExpiry: now,
        createdTs: now,
        updatedTs: now,
    };
}

function makeSyncConfig(userId: string): CalendarSyncConfigInterface {
    const now = dayjs().toISOString();
    return {
        _id: 'sync-issues',
        integrationId: 'int-issues',
        user: userId,
        calendarId: 'primary',
        isDefault: true,
        enabled: true,
        timeZone: 'Asia/Jerusalem',
        createdTs: now,
        updatedTs: now,
    };
}

function makeCalendarItem(userId: string, itemId: string): ItemInterface {
    const now = dayjs().toISOString();
    return {
        _id: itemId,
        user: userId,
        status: 'calendar',
        title: 'Linked meeting',
        timeStart: dayjs().add(1, 'day').toISOString(),
        timeEnd: dayjs().add(1, 'day').add(30, 'minute').toISOString(),
        calendarEventId: 'gcal-evt-1',
        calendarIntegrationId: 'int-issues',
        calendarSyncConfigId: 'sync-issues',
        attendees: [
            { email: 'me@example.com', responseStatus: 'needsAction', self: true },
            { email: 'host@example.com', responseStatus: 'accepted', organizer: true },
        ],
        responseStatus: 'needsAction',
        createdTs: now,
        updatedTs: now,
    };
}

/**
 * Seeds the 2026-08-19 incident shape: a GCal-linked daily routine, one trashed generated
 * instance, and the instance's update op previously marked failed by a rate-limited (403)
 * cancellation PATCH. Returns the failed op ready for a /sync/issues/:opId/retry call.
 */
async function seedRateLimitedCancellationOp(userId: string): Promise<OperationInterface> {
    await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
    await calendarSyncConfigsDAO.insertOne(makeSyncConfig(userId));
    const now = dayjs().toISOString();
    const routine: RoutineInterface = {
        _id: `routine-${crypto.randomUUID()}`,
        user: userId,
        title: 'Daily standup',
        routineType: 'calendar',
        rrule: 'FREQ=DAILY',
        template: {},
        active: true,
        createdTs: now,
        updatedTs: now,
        calendarItemTemplate: { timeOfDay: '09:45', duration: 15 },
        calendarEventId: 'recurring-master-issues',
        calendarIntegrationId: 'int-issues',
        calendarSyncConfigId: 'sync-issues',
    };
    await routinesDAO.insertOne(routine);
    const trashedInstance: ItemInterface = {
        _id: `item-${crypto.randomUUID()}`,
        user: userId,
        status: 'trash',
        title: 'Daily standup',
        routineId: routine._id,
        timeStart: dayjs().add(6, 'day').toISOString(),
        timeEnd: dayjs().add(6, 'day').add(15, 'minute').toISOString(),
        createdTs: now,
        updatedTs: now,
    };
    await itemsDAO.insertOne(trashedInstance);
    const op = makeFailedOp(userId, {
        entityId: trashedInstance._id as string,
        opType: 'update',
        snapshot: trashedInstance,
        failureReason: 'transient_exhausted',
        failureDetail: 'Rate Limit Exceeded',
    });
    await operationsDAO.insertOne(op);
    return op;
}

// ─── GET /sync/issues ──────────────────────────────────────────────────────

describe('GET /sync/issues', () => {
    it('returns rows for the session user with retryable flagged per failureReason', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);

        await operationsDAO.insertMany([
            makeFailedOp(userId, { failureReason: 'transient_exhausted' }),
            makeFailedOp(userId, { failureReason: 'scope_missing' }),
            makeFailedOp(userId, { failureReason: 'terminal' }),
        ]);

        const res = await authenticatedRequest(app, { method: 'GET', path: '/sync/issues', sessionCookie: cookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { issues: Array<{ failureReason: OpFailureReason; retryable: boolean }> };
        expect(body.issues).toHaveLength(3);
        const byReason = new Map(body.issues.map((i) => [i.failureReason, i.retryable]));
        expect(byReason.get('transient_exhausted')).toBe(true);
        expect(byReason.get('scope_missing')).toBe(true);
        expect(byReason.get('terminal')).toBe(false);
    });

    it('includes entityTitle from the op snapshot, with a live-item fallback for snapshot-less rsvp ops', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        const liveItemId = `item-${crypto.randomUUID()}`;
        await itemsDAO.insertOne(makeCalendarItem(userId, liveItemId));

        const snapshotOp = makeFailedOp(userId, {
            failureReason: 'entity_missing',
            opType: 'update',
            snapshot: { ...makeCalendarItem(userId, `item-${crypto.randomUUID()}`), title: 'Ghost item title' },
        });
        // rsvp ops carry no snapshot — the title must come from the live item.
        const rsvpOp = makeFailedOp(userId, { failureReason: 'scope_missing', entityId: liveItemId });
        // delete op on a gone entity: no snapshot AND no live item → row stays untitled.
        const untitledOp = makeFailedOp(userId, { failureReason: 'entity_missing', opType: 'delete' });
        // Non-item snapshots carry `name`, not `title` — the projection must read either.
        const now = dayjs().toISOString();
        const personOp = makeFailedOp(userId, {
            failureReason: 'entity_missing',
            opType: 'update',
            entityType: 'person',
            snapshot: { _id: `person-${crypto.randomUUID()}`, user: userId, name: 'Dana Cohen', createdTs: now, updatedTs: now },
        });
        await operationsDAO.insertMany([snapshotOp, rsvpOp, untitledOp, personOp]);

        const res = await authenticatedRequest(app, { method: 'GET', path: '/sync/issues', sessionCookie: cookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { issues: Array<{ _id: string; entityTitle?: string; failedTs?: string }> };
        const rowById = new Map(body.issues.map((i) => [i._id, i]));
        expect(rowById.get(snapshotOp._id)?.entityTitle).toBe('Ghost item title');
        expect(rowById.get(rsvpOp._id)?.entityTitle).toBe('Linked meeting');
        expect(rowById.get(untitledOp._id)?.entityTitle).toBeUndefined();
        expect(rowById.get(personOp._id)?.entityTitle).toBe('Dana Cohen');
        // failedTs rides along so the panel can display when the failure happened (ts mutates on retry).
        expect(rowById.get(snapshotOp._id)?.failedTs).toBe(snapshotOp.failedTs);
    });

    it("does not leak another user's item title into the live-title fallback (tenant isolation)", async () => {
        const aliceCookie = await loginAsAlice();
        const bobCookie = await loginAsBob();
        const aliceId = await getUserId(aliceCookie);
        const bobItemId = `item-${crypto.randomUUID()}`;
        // Bob owns the item; Alice has a snapshot-less rsvp op pointing at its id.
        await itemsDAO.insertOne(makeCalendarItem(await getUserId(bobCookie), bobItemId));
        await operationsDAO.insertOne(makeFailedOp(aliceId, { failureReason: 'scope_missing', entityId: bobItemId }));

        const res = await authenticatedRequest(app, { method: 'GET', path: '/sync/issues', sessionCookie: aliceCookie });
        const body = (await res.json()) as { issues: Array<{ entityTitle?: string }> };
        expect(body.issues).toHaveLength(1);
        const [row] = body.issues;
        if (!row) throw new Error('expected one issue row');
        expect(row.entityTitle).toBeUndefined(); // Bob's title must never surface
    });

    it('omits ops without syncFailed and ops belonging to other users (tenant isolation)', async () => {
        const aliceCookie = await loginAsAlice();
        const bobCookie = await loginAsBob();
        const aliceId = await getUserId(aliceCookie);
        const bobId = await getUserId(bobCookie);

        // One failed op per user, plus a healthy op for Alice that must NOT be returned.
        const aliceFailed = makeFailedOp(aliceId, { failureReason: 'transient_exhausted' });
        const bobFailed = makeFailedOp(bobId, { failureReason: 'terminal' });
        const aliceHealthy: OperationInterface = {
            _id: 'op-healthy',
            user: aliceId,
            deviceId: 'dev-1',
            ts: dayjs().toISOString(),
            entityType: 'item',
            entityId: 'item-healthy',
            opType: 'update',
            snapshot: null,
        };
        await operationsDAO.insertMany([aliceFailed, bobFailed, aliceHealthy]);

        const res = await authenticatedRequest(app, { method: 'GET', path: '/sync/issues', sessionCookie: aliceCookie });
        const body = (await res.json()) as { issues: Array<{ _id: string }> };
        const returnedIds = body.issues.map((i) => i._id);
        expect(returnedIds).toContain(aliceFailed._id);
        expect(returnedIds).not.toContain(bobFailed._id); // tenant isolation
        expect(returnedIds).not.toContain(aliceHealthy._id); // healthy op never surfaced
    });
});

// ─── POST /sync/issues/:opId/dismiss ───────────────────────────────────────

describe('POST /sync/issues/:opId/dismiss', () => {
    it('deletes the op row for the session user', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        const op = makeFailedOp(userId, { failureReason: 'terminal' });
        await operationsDAO.insertOne(op);

        const res = await authenticatedRequest(app, { method: 'POST', path: `/sync/issues/${op._id}/dismiss`, sessionCookie: cookie });
        expect(res.status).toBe(200);
        expect(await operationsDAO.findOne({ _id: op._id })).toBeNull();
    });

    it("returns 404 when dismissing another user's op (tenant isolation)", async () => {
        const aliceCookie = await loginAsAlice();
        const bobCookie = await loginAsBob();
        const aliceId = await getUserId(aliceCookie);
        const bobOp = makeFailedOp(await getUserId(bobCookie), { failureReason: 'terminal' });
        await operationsDAO.insertOne(bobOp);

        // Alice tries to dismiss Bob's op — must 404 and the row must remain.
        const res = await authenticatedRequest(app, { method: 'POST', path: `/sync/issues/${bobOp._id}/dismiss`, sessionCookie: aliceCookie });
        expect(res.status).toBe(404);
        const stillThere = await operationsDAO.findOne({ _id: bobOp._id });
        expect(stillThere?.user).toBe(bobOp.user);
        // Sanity: Alice's own ops untouched (the misfire didn't leak into Alice's row set).
        expect(await operationsDAO.findArray({ user: aliceId })).toHaveLength(0);
    });
});

// ─── POST /sync/issues/:opId/retry ─────────────────────────────────────────

describe('POST /sync/issues/:opId/retry', () => {
    it('clears the row + re-runs replayRsvpOp + deletes the op on success', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        const itemId = `item-${crypto.randomUUID()}`;
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(userId));
        await itemsDAO.insertOne(makeCalendarItem(userId, itemId));

        // Seed a previously-failed rsvp op (scope_missing) so the panel surfaces it as retryable.
        const op = makeFailedOp(userId, {
            entityId: itemId,
            failureReason: 'scope_missing',
            rsvp: {
                itemId,
                calendarEventId: 'gcal-evt-1',
                calendarIntegrationId: 'int-issues',
                responseStatus: 'accepted',
            },
        });
        await operationsDAO.insertOne(op);

        // This time the provider succeeds — replayRsvpOp should clear the op row.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getMyEmail').mockResolvedValue('me@example.com');
        const patchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'patchEventAttendees').mockResolvedValue(undefined);

        const res = await authenticatedRequest(app, { method: 'POST', path: `/sync/issues/${op._id}/retry`, sessionCookie: cookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean };
        expect(body.ok).toBe(true);
        expect(patchSpy).toHaveBeenCalledOnce();
        // Successful retry → op row is gone, panel entry clears on next fetch.
        expect(await operationsDAO.findOne({ _id: op._id })).toBeNull();
    });

    it('re-marks syncFailed when the retry hits the same failure again', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        const itemId = `item-${crypto.randomUUID()}`;
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(userId));
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(userId));
        await itemsDAO.insertOne(makeCalendarItem(userId, itemId));

        const op = makeFailedOp(userId, {
            entityId: itemId,
            failureReason: 'scope_missing',
            rsvp: { itemId, calendarEventId: 'gcal-evt-1', calendarIntegrationId: 'int-issues', responseStatus: 'declined' },
        });
        await operationsDAO.insertOne(op);

        vi.spyOn(GoogleCalendarProvider.prototype, 'getMyEmail').mockResolvedValue('me@example.com');
        vi.spyOn(GoogleCalendarProvider.prototype, 'patchEventAttendees').mockRejectedValue(new Error('invalid_grant'));

        const res = await authenticatedRequest(app, { method: 'POST', path: `/sync/issues/${op._id}/retry`, sessionCookie: cookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; failureReason?: string };
        expect(body.ok).toBe(false);
        // Same op row, re-marked as failed.
        const refreshed = await operationsDAO.findOne({ _id: op._id });
        expect(refreshed?.syncFailed).toBe(true);
        expect(refreshed?.failureReason).toBe('scope_missing');
        expect(body.failureReason).toBe('scope_missing');
    });

    it('returns 400 when the op is terminal (not retryable)', async () => {
        const cookie = await loginAsAlice();
        const userId = await getUserId(cookie);
        const op = makeFailedOp(userId, { failureReason: 'terminal' });
        await operationsDAO.insertOne(op);

        const res = await authenticatedRequest(app, { method: 'POST', path: `/sync/issues/${op._id}/retry`, sessionCookie: cookie });
        expect(res.status).toBe(400);
        // Terminal op left untouched — dismiss is the only path forward.
        const refreshed = await operationsDAO.findOne({ _id: op._id });
        expect(refreshed?.syncFailed).toBe(true);
    });

    it('retries a rate-limited routine-instance cancellation via the generic pushback and clears the row on success', async () => {
        // End-to-end shape of the 2026-08-19 incident: a burst-trash cancellation PATCH was
        // rate-limited (403 Rate Limit Exceeded → transient_exhausted). The panel's Retry must
        // re-fire maybePushToGCal, land the cancellation once Google stops throttling, and clear
        // the row.
        const cookie = await loginAsAlice();
        const op = await seedRateLimitedCancellationOp(await getUserId(cookie));

        // Google has stopped throttling — the retried cancellation goes through.
        const cancelSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockResolvedValue(undefined);

        const res = await authenticatedRequest(app, { method: 'POST', path: `/sync/issues/${op._id}/retry`, sessionCookie: cookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean };
        expect(body.ok).toBe(true);
        expect(cancelSpy).toHaveBeenCalledOnce();
        expect(cancelSpy.mock.calls[0]?.[0]).toBe('recurring-master-issues');
        expect(await operationsDAO.findOne({ _id: op._id })).toBeNull();
    });

    it('re-marks a routine-instance cancellation retry that is rate-limited again', async () => {
        const cookie = await loginAsAlice();
        const op = await seedRateLimitedCancellationOp(await getUserId(cookie));

        const stillThrottled = Object.assign(new Error('Rate Limit Exceeded'), {
            code: 403,
            errors: [{ reason: 'rateLimitExceeded' }],
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockRejectedValue(stillThrottled);

        const res = await authenticatedRequest(app, { method: 'POST', path: `/sync/issues/${op._id}/retry`, sessionCookie: cookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; failureReason?: string };
        expect(body.ok).toBe(false);
        expect(body.failureReason).toBe('transient_exhausted');
        // Row stays retryable — not demoted to terminal by the 403.
        const refreshed = await operationsDAO.findOne({ _id: op._id });
        expect(refreshed?.syncFailed).toBe(true);
        expect(refreshed?.failureReason).toBe('transient_exhausted');
    });

    it("returns 404 when retrying another user's op (tenant isolation)", async () => {
        const aliceCookie = await loginAsAlice();
        const bobCookie = await loginAsBob();
        const bobOp = makeFailedOp(await getUserId(bobCookie), { failureReason: 'scope_missing' });
        await operationsDAO.insertOne(bobOp);

        const res = await authenticatedRequest(app, { method: 'POST', path: `/sync/issues/${bobOp._id}/retry`, sessionCookie: aliceCookie });
        expect(res.status).toBe(404);
        // Bob's op preserved — no cross-tenant write.
        const stillThere = await operationsDAO.findOne({ _id: bobOp._id });
        expect(stillThere?.syncFailed).toBe(true);
    });
});
