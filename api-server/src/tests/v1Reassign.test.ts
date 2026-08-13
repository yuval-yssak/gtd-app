/** Public-API /v1/reassign (Phase 2 step 5). Wraps lib/reassignEntity.ts; the bearer token's
 * userId becomes `fromUserId`. Existing reassign internals (cross-account move, edit-patch
 * application, GCal create-on-target) are exhaustively unit-tested in `reassign.test.ts` —
 * the tests here focus on the route layer: scope gating, body validation, the same-user guard,
 * and the route-level happy path so a refactor can't sever the route from the orchestrator. */
/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import * as sseConnections from '../lib/sseConnections.js';
import * as webPush from '../lib/webPush.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { v1ReassignRoutes } from '../routes/v1/reassign.js';
import type { ApiTokenScope } from '../types/entities.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/v1', v1ReassignRoutes);

beforeAll(async () => {
    await loadDataAccess('gtd_test');
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
        db.collection('apiTokens').deleteMany({}),
        db.collection('items').deleteMany({}),
        db.collection('workContexts').deleteMany({}),
        db.collection('routines').deleteMany({}),
        db.collection('operations').deleteMany({}),
        db.collection('webhookSubscriptions').deleteMany({}),
        db.collection('webhookDeliveries').deleteMany({}),
    ]);
    __resetDefaultStoreForTests();
    vi.restoreAllMocks();
});

async function login(): Promise<string> {
    const { sessionCookie } = await oauthLogin(app, 'google');
    const sessionRes = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
    const { user } = (await sessionRes.json()) as { user: { id: string } };
    return user.id;
}

async function tokenWith(userId: string, scopes: ApiTokenScope[]): Promise<string> {
    const { plaintext } = await issueApiToken(userId, 't', scopes);
    return plaintext;
}

/**
 * Mints a recipient token for `toUserId` carrying `reassign.accept`. Tests that exercise the
 * happy path of `/v1/reassign` need to send this in `X-Reassign-Recipient-Token`.
 */
async function recipientTokenFor(toUserId: string, scopes: ApiTokenScope[] = ['reassign.accept']): Promise<string> {
    const { plaintext } = await issueApiToken(toUserId, 'recipient', scopes);
    return plaintext;
}

describe('POST /v1/reassign', () => {
    it('moves a non-calendar item from the calling token user to toUserId when the recipient consents', async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['reassign']);
        const recipient = await recipientTokenFor('bob-id');
        await itemsDAO.insertOne({
            _id: 'it-1',
            user: aliceId,
            status: 'inbox',
            title: 'transfer me',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'X-Reassign-Recipient-Token': recipient, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'item', entityId: 'it-1', toUserId: 'bob-id' }),
            }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean };
        expect(body.ok).toBe(true);
        // Item now belongs to Bob.
        const moved = await itemsDAO.findByOwnerAndId('it-1', 'bob-id');
        expect(moved).not.toBeNull();
        const stale = await itemsDAO.findByOwnerAndId('it-1', aliceId);
        expect(stale).toBeNull();
    });

    it('retry of a completed item move returns 200 with alreadyMoved instead of a 404', async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['reassign']);
        const recipient = await recipientTokenFor('bob-id');
        await itemsDAO.insertOne({
            _id: 'it-retry',
            user: aliceId,
            status: 'inbox',
            title: 'transfer me twice',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const request = () =>
            app.fetch(
                new Request('http://localhost:4000/v1/reassign', {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}`, 'X-Reassign-Recipient-Token': recipient, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ entityType: 'item', entityId: 'it-retry', toUserId: 'bob-id' }),
                }),
            );
        const first = await request();
        expect(first.status).toBe(200);
        expect(((await first.json()) as { alreadyMoved?: boolean }).alreadyMoved).toBeUndefined();

        const retry = await request();
        expect(retry.status).toBe(200);
        expect(((await retry.json()) as { ok: boolean; alreadyMoved?: boolean }).alreadyMoved).toBe(true);
        expect(await itemsDAO.findByOwnerAndId('it-retry', 'bob-id')).not.toBeNull();
        expect(await itemsDAO.findByOwnerAndId('it-retry', aliceId)).toBeNull();
    });

    it('retry of a completed routine move returns 200 with alreadyMoved instead of a 404', async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['reassign']);
        const recipient = await recipientTokenFor('bob-id');
        await routinesDAO.insertOne({
            _id: 'rt-retry',
            user: aliceId,
            title: 'weekly transfer',
            routineType: 'nextAction',
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            template: {},
            active: true,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const request = () =>
            app.fetch(
                new Request('http://localhost:4000/v1/reassign', {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}`, 'X-Reassign-Recipient-Token': recipient, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ entityType: 'routine', entityId: 'rt-retry', toUserId: 'bob-id' }),
                }),
            );
        const first = await request();
        expect(first.status).toBe(200);

        const retry = await request();
        expect(retry.status).toBe(200);
        expect(((await retry.json()) as { ok: boolean; alreadyMoved?: boolean }).alreadyMoved).toBe(true);
        expect(await routinesDAO.findByOwnerAndId('rt-retry', 'bob-id')).not.toBeNull();
        expect(await routinesDAO.findByOwnerAndId('rt-retry', aliceId)).toBeNull();
    });

    // Step 4 of the fan-out fix series: callers copy-pasting from Authorization examples often
    // prefix the recipient header with "Bearer ". The route strips a leading "Bearer " before
    // resolveBearerToken so both shapes resolve to the same row.
    it('accepts both bare and "Bearer "-prefixed shapes for X-Reassign-Recipient-Token', async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['reassign']);
        const recipient = await recipientTokenFor('bob-id');
        await itemsDAO.insertOne({
            _id: 'it-bare',
            user: aliceId,
            status: 'inbox',
            title: 'bare',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const bareRes = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'X-Reassign-Recipient-Token': recipient, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'item', entityId: 'it-bare', toUserId: 'bob-id' }),
            }),
        );
        expect(bareRes.status).toBe(200);

        // Second call with the same recipient token but `Bearer ` prefix — must also succeed.
        await itemsDAO.insertOne({
            _id: 'it-pref',
            user: aliceId,
            status: 'inbox',
            title: 'prefixed',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const prefRes = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'X-Reassign-Recipient-Token': `Bearer ${recipient}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'item', entityId: 'it-pref', toUserId: 'bob-id' }),
            }),
        );
        expect(prefRes.status).toBe(200);
    });

    it('rejects same-user reassign with same_user code', async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['reassign']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'item', entityId: 'it-1', toUserId: aliceId }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('same_user');
    });

    it('rejects unknown entityType', async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['reassign']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'banana', entityId: 'x', toUserId: 'bob' }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_entityType');
    });

    it('returns 403 when token lacks reassign scope', async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['items.write']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'item', entityId: 'it-1', toUserId: 'bob' }),
            }),
        );
        expect(res.status).toBe(403);
    });

    it('returns 404 when the entity is not owned by the calling token user (routine path)', async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['reassign']);
        const recipient = await recipientTokenFor('carol-id');
        // Seed Bob's routine — Alice cannot reassign it because reassignEntity reads by fromUserId.
        await routinesDAO.insertOne({
            _id: 'rt-bob',
            user: 'bob-id',
            title: 'bobs routine',
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY',
            template: {},
            active: true,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'X-Reassign-Recipient-Token': recipient, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'routine', entityId: 'rt-bob', toUserId: 'carol-id' }),
            }),
        );
        expect(res.status).toBe(404);
    });

    // The body parser rejects person/workContext at the validation layer — they cannot be
    // reassigned. The orchestrator's auto-relink logic handles cross-user refs on item/routine
    // moves; direct person/workContext reassigns are intentionally not part of the surface.
    it('rejects entityType=person with 400 invalid_entityType', async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['reassign']);
        const recipient = await recipientTokenFor('carol-id');
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'X-Reassign-Recipient-Token': recipient, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'person', entityId: 'p-1', toUserId: 'carol-id' }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_entityType');
    });

    it('rejects entityType=workContext with 400 invalid_entityType', async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['reassign']);
        const recipient = await recipientTokenFor('carol-id');
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'X-Reassign-Recipient-Token': recipient, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'workContext', entityId: 'wc-1', toUserId: 'carol-id' }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_entityType');
    });

    // Tenant isolation: Alice cannot reassign Bob's item even via the items path. Pins the
    // route-level guard against a future refactor that swaps `findByOwner` for a non-scoped
    // finder. (We test the items path here because the workContext path is in a separate test.)
    it("returns 404 when targeting another user's item (tenant isolation)", async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['reassign']);
        const recipient = await recipientTokenFor('carol-id');
        await itemsDAO.insertOne({
            _id: 'it-bob',
            user: 'bob-id',
            status: 'inbox',
            title: 'bobs',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'X-Reassign-Recipient-Token': recipient, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'item', entityId: 'it-bob', toUserId: 'carol-id' }),
            }),
        );
        expect(res.status).toBe(404);
        // Bob's item is unmoved.
        const stillBobs = await itemsDAO.findByOwnerAndId('it-bob', 'bob-id');
        expect(stillBobs).not.toBeNull();
        expect(stillBobs?.user).toBe('bob-id');
    });

    it("stamps deviceId='api:<tokenId>' on the recorded delete + create ops", async () => {
        const aliceId = await login();
        const { plaintext, record } = await issueApiToken(aliceId, 'auditable', ['reassign']);
        const recipient = await recipientTokenFor('bob-id');
        await itemsDAO.insertOne({
            _id: 'it-audit',
            user: aliceId,
            status: 'inbox',
            title: 'audit',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${plaintext}`, 'X-Reassign-Recipient-Token': recipient, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'item', entityId: 'it-audit', toUserId: 'bob-id' }),
            }),
        );
        expect(res.status).toBe(200);
        // Two ops are recorded for a reassign — a delete under fromUserId and a create under toUserId.
        // Both must carry the api:<tokenId> deviceId so audits can attribute the move to this token.
        const ops = await db
            .collection<{ entityId: string; deviceId: string; opType: string; user: string }>('operations')
            .find({ entityId: 'it-audit' })
            .toArray();
        expect(ops).toHaveLength(2);
        for (const op of ops) {
            expect(op.deviceId).toBe(`api:${record._id}`);
        }
    });

    // ── Recipient-consent enforcement ─────────────────────────────────────────
    // The new two-token gate fires after `same_user` and parse, before `reassignEntity`. Each
    // case below pins one failure mode so a future refactor can't silently relax the contract.

    it('rejects with recipient_consent_required when X-Reassign-Recipient-Token is missing', async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['reassign']);
        await itemsDAO.insertOne({
            _id: 'it-2',
            user: aliceId,
            status: 'inbox',
            title: 'x',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'item', entityId: 'it-2', toUserId: 'bob-id' }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('recipient_consent_required');
        // Item must NOT have moved — consent gate runs before any persistence.
        const stillAlice = await itemsDAO.findByOwnerAndId('it-2', aliceId);
        expect(stillAlice).not.toBeNull();
    });

    it('rejects with invalid_recipient_token when the recipient header does not resolve', async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['reassign']);
        // Seed the item up-front so the persistence-intact assertion has something concrete to find.
        await itemsDAO.insertOne({
            _id: 'it-3',
            user: aliceId,
            status: 'inbox',
            title: 'consent-gate-pin',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'X-Reassign-Recipient-Token': 'gtd_definitely-not-a-real-token',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ entityType: 'item', entityId: 'it-3', toUserId: 'bob-id' }),
            }),
        );
        expect(res.status).toBe(401);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_recipient_token');
        // Persistence-intact: the consent gate must fire BEFORE any reassign-side write.
        const stillAlice = await itemsDAO.findByOwnerAndId('it-3', aliceId);
        expect(stillAlice).not.toBeNull();
        const onBob = await itemsDAO.findByOwnerAndId('it-3', 'bob-id');
        expect(onBob).toBeNull();
    });

    it('rejects with recipient_token_mismatch when the recipient token belongs to a different user', async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['reassign']);
        // Carol mints a reassign.accept token, but the caller targets Bob — mismatch.
        const carolToken = await recipientTokenFor('carol-id');
        await itemsDAO.insertOne({
            _id: 'it-4',
            user: aliceId,
            status: 'inbox',
            title: 'consent-gate-pin',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'X-Reassign-Recipient-Token': carolToken, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'item', entityId: 'it-4', toUserId: 'bob-id' }),
            }),
        );
        expect(res.status).toBe(403);
        expect(((await res.json()) as { code: string }).code).toBe('recipient_token_mismatch');
        // Persistence-intact: nothing moves under either user.
        const stillAlice = await itemsDAO.findByOwnerAndId('it-4', aliceId);
        expect(stillAlice).not.toBeNull();
        expect(await itemsDAO.findByOwnerAndId('it-4', 'bob-id')).toBeNull();
        expect(await itemsDAO.findByOwnerAndId('it-4', 'carol-id')).toBeNull();
    });

    it('rejects with recipient_scope_missing when the recipient token lacks reassign.accept', async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['reassign']);
        // Bob has a token, but with the wrong scope — explicit opt-in is the whole point.
        const bobToken = await recipientTokenFor('bob-id', ['items.read']);
        await itemsDAO.insertOne({
            _id: 'it-5',
            user: aliceId,
            status: 'inbox',
            title: 'consent-gate-pin',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'X-Reassign-Recipient-Token': bobToken, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'item', entityId: 'it-5', toUserId: 'bob-id' }),
            }),
        );
        expect(res.status).toBe(403);
        expect(((await res.json()) as { code: string }).code).toBe('recipient_scope_missing');
        // Persistence-intact: missing scope on the recipient blocks the move before any write.
        const stillAlice = await itemsDAO.findByOwnerAndId('it-5', aliceId);
        expect(stillAlice).not.toBeNull();
        expect(await itemsDAO.findByOwnerAndId('it-5', 'bob-id')).toBeNull();
    });

    it('rejects with same_token when caller and recipient tokens are the same row', async () => {
        const aliceId = await login();
        // Mint Alice a token carrying both `reassign` and `reassign.accept`, then point its same
        // raw plaintext at the recipient header while targeting a different user. The same-token
        // check fires before the user-match check inside `validateRecipientConsent`, so this
        // surfaces as `same_token` (defense in depth — even if a caller bypassed `same_user`,
        // the route still won't let one token consent to its own move).
        const token = await tokenWith(aliceId, ['reassign', 'reassign.accept']);
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'X-Reassign-Recipient-Token': token, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'item', entityId: 'it-6', toUserId: 'bob-id' }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('same_token');
    });

    // ── Fan-out parity (step 3 of the consent + fan-out overhaul) ────────────
    // Reassign now flows through `applyAndPublishOperation` for both legs (delete on fromUserId,
    // create on toUserId), so SSE / web push / GCal / webhook fan-out should fire on BOTH user
    // channels — closing the long-standing pipeline gap that left external integrations blind to
    // cross-account moves.

    it('fires SSE notify for both fromUserId and toUserId', async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['reassign']);
        const recipient = await recipientTokenFor('bob-id');
        const sseSpy = vi.spyOn(sseConnections, 'notifyUserViaSse');
        await itemsDAO.insertOne({
            _id: 'it-sse',
            user: aliceId,
            status: 'inbox',
            title: 'sse',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'X-Reassign-Recipient-Token': recipient, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'item', entityId: 'it-sse', toUserId: 'bob-id' }),
            }),
        );
        expect(res.status).toBe(200);
        // Each `applyAndPublishOperation` leg fires `notifyUserViaSse` once with the op's user.
        const sseUserIds = sseSpy.mock.calls.map(([userId]) => userId);
        expect(sseUserIds).toContain(aliceId);
        expect(sseUserIds).toContain('bob-id');
    });

    it('enqueues a webhook delivery for the target user when a matching subscription exists', async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['reassign']);
        const recipient = await recipientTokenFor('bob-id');
        // The webhook event catalog today is item.created + item.completed (`mapOpToEvents`).
        // Reassign produces a target-side create; Bob's `item.created` subscription should fire.
        // The source-side delete maps to no webhook event under the current catalog — we still
        // assert the SSE+pipeline parity in the prior test, which is the load-bearing property.
        await db.collection('webhookSubscriptions').insertOne({
            _id: 'sub-bob',
            user: 'bob-id',
            url: 'https://hooks.example/b',
            events: ['item.created'],
            secret: 's-b',
            createdTs: '2026-01-01T00:00:00Z',
        } as never);
        await itemsDAO.insertOne({
            _id: 'it-hook',
            user: aliceId,
            status: 'inbox',
            title: 'webhook',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'X-Reassign-Recipient-Token': recipient, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'item', entityId: 'it-hook', toUserId: 'bob-id' }),
            }),
        );
        expect(res.status).toBe(200);
        // notifyChange enqueues fire-and-forget; poll briefly so we don't race the worker's tick.
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline) {
            const total = await db.collection('webhookDeliveries').countDocuments({ subscriptionId: 'sub-bob' });
            if (total >= 1) break;
            await new Promise<void>((r) => setTimeout(r, 20));
        }
        const bobDeliveries = await db.collection('webhookDeliveries').countDocuments({ subscriptionId: 'sub-bob', user: 'bob-id' });
        expect(bobDeliveries).toBeGreaterThanOrEqual(1);
    });

    // Step 3 of the fan-out fix series: a transient throw out of `notifyViaWebPush` (e.g. a
    // Mongo blip on the subscription lookup) used to abort the orchestrator before the target-
    // create leg ran — leaving the entity deleted from source but never created on target. The
    // fix wraps the awaited `notifyViaWebPush` leg in try/catch + log inside `notifyChange`,
    // making the failure non-fatal. This test pins that the torn state is no longer reachable.
    it('does not produce a torn state when notifyViaWebPush throws on the source-delete leg', async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['reassign']);
        const recipient = await recipientTokenFor('bob-id');
        await itemsDAO.insertOne({
            _id: 'it-torn',
            user: aliceId,
            status: 'inbox',
            title: 'transient',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        // Throw only on the first call (source-delete leg). The target-create leg's notify call
        // also runs through notifyViaWebPush — leaving it unmocked confirms it succeeds.
        const webPushSpy = vi.spyOn(webPush, 'notifyViaWebPush').mockRejectedValueOnce(new Error('mongo blip'));
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'X-Reassign-Recipient-Token': recipient, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'item', entityId: 'it-torn', toUserId: 'bob-id' }),
            }),
        );

        // Caller still observes ok=true — the swallow keeps the move on its rails.
        expect(res.status).toBe(200);
        expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
        // Both DB legs landed: source deleted, target created.
        expect(await itemsDAO.findByOwnerAndId('it-torn', aliceId)).toBeNull();
        expect(await itemsDAO.findByOwnerAndId('it-torn', 'bob-id')).not.toBeNull();
        // Both ops are in the operations log (delete on Alice, create on Bob).
        const ops = await db.collection<{ entityId: string; opType: string; user: string }>('operations').find({ entityId: 'it-torn' }).toArray();
        expect(ops.find((o) => o.opType === 'delete' && o.user === aliceId)).toBeDefined();
        expect(ops.find((o) => o.opType === 'create' && o.user === 'bob-id')).toBeDefined();
        // The thrown error was logged.
        expect(webPushSpy).toHaveBeenCalled();
        const tag = errSpy.mock.calls.find((call) => typeof call[0] === 'string' && (call[0] as string).startsWith('[notify-change] notifyViaWebPush failed'));
        expect(tag).toBeDefined();
    });

    it('returns 400 validation_failed when a reassigned snapshot violates the status×field matrix', async () => {
        const aliceId = await login();
        const token = await tokenWith(aliceId, ['reassign']);
        const recipient = await recipientTokenFor('bob-id');
        // Item status='inbox' carrying `urgent: true` is an existing matrix violation that strict
        // mode now catches — without strict-mode validation in step 3 the move would silently
        // copy the corrupt row across accounts. The pre-validation guard in persistItemMove
        // ensures the source delete never fires when the target create would fail.
        await itemsDAO.insertOne({
            _id: 'it-bad',
            user: aliceId,
            status: 'inbox',
            title: 'bad',
            urgent: true,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await app.fetch(
            new Request('http://localhost:4000/v1/reassign', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'X-Reassign-Recipient-Token': recipient, 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityType: 'item', entityId: 'it-bad', toUserId: 'bob-id' }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('validation_failed');
        // Pre-validation gate: the source row must still be intact, so a malformed snapshot can't
        // create a torn state (deleted on source, never created on target).
        const stillAlice = await itemsDAO.findByOwnerAndId('it-bad', aliceId);
        expect(stillAlice).not.toBeNull();
        const onBob = await itemsDAO.findByOwnerAndId('it-bad', 'bob-id');
        expect(onBob).toBeNull();
    });
});
