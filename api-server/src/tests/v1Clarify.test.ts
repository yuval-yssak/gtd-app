/** PATCH /v1/items/:id (clarify) + token scopes — issue #19 step 7.
 *
 * The clarify/complete write surface is gated by the `items.write` scope. (The former
 * `items.clarify` scope was retired; legacy stored rows are migrated to `items.write` at boot —
 * see `loaders/apiTokenScopeMigration.ts`.) */
/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import apiTokensDAO from '../dataAccess/apiTokensDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { tokensRoutes } from '../routes/tokens.js';
import { v1ItemsRoutes } from '../routes/v1/items.js';
import { ItemStatus } from '../types/entities.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono()
    .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
    .route('/account/tokens', tokensRoutes)
    .route('/v1', v1ItemsRoutes);

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
        db.collection('items').deleteMany({}),
        db.collection('operations').deleteMany({}),
        db.collection('apiTokens').deleteMany({}),
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

async function createInboxItem(plaintext: string, externalId: string, title = 't'): Promise<string> {
    const res = await app.fetch(
        new Request('http://localhost:4000/v1/items', {
            method: 'POST',
            headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, externalId }),
        }),
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { _id: string })._id;
}

async function patch(plaintext: string, id: string, body: unknown): Promise<Response> {
    return app.fetch(
        new Request(`http://localhost:4000/v1/items/${id}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
    );
}

describe('PATCH /v1/items/:id', () => {
    it('clarifies an inbox item to nextAction with metadata', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.write']);
        const id = await createInboxItem(plaintext, 'ext-1');

        const res = await patch(plaintext, id, { status: 'nextAction', energy: 'low', time: 5, urgent: true });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; energy: string; time: number; urgent: boolean };
        expect(body.status).toBe('nextAction');
        expect(body.energy).toBe('low');
        expect(body.time).toBe(5);
        expect(body.urgent).toBe(true);
    });

    // Phase 3 broadened PATCH to a full-surface update: calendar/done/trash transitions are
    // now allowed, validated by RoutineSnapshotSchema/ItemSnapshotSchema in strict mode. The
    // "rejects status:calendar" and "rejects status:done" assertions from the clarify-only era
    // are folded into the matrix-coverage tests below.
    it('accepts status: calendar with timeStart + timeEnd (Phase 3 broadened surface)', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.write']);
        const id = await createInboxItem(plaintext, 'ext-1');
        const res = await patch(plaintext, id, { status: 'calendar', timeStart: '2099-04-01T10:00:00Z', timeEnd: '2099-04-01T11:00:00Z' });
        expect(res.status).toBe(200);
        const stored = await itemsDAO.findByOwnerAndId(id, userId);
        expect(stored?.status).toBe('calendar');
        expect(stored?.timeStart).toBe('2099-04-01T10:00:00Z');
    });

    it('accepts status: done via PATCH (the POST /complete shortcut is still available)', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.write']);
        const id = await createInboxItem(plaintext, 'ext-1');
        const res = await patch(plaintext, id, { status: 'done' });
        expect(res.status).toBe(200);
        const stored = await itemsDAO.findByOwnerAndId(id, userId);
        expect(stored?.status).toBe('done');
    });

    it('rejects forbidden fields (e.g., user, contentHash)', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.write']);
        const id = await createInboxItem(plaintext, 'ext-1');
        const res = await patch(plaintext, id, { user: 'someone-else' });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('forbidden_field');
    });

    it('rejects empty bodies with empty_body', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.write']);
        const id = await createInboxItem(plaintext, 'ext-1');
        const res = await patch(plaintext, id, {});
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('empty_body');
    });

    it('returns 404 for items that do not exist', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.write']);
        const res = await patch(plaintext, '00000000-0000-0000-0000-000000000000', { status: 'nextAction' });
        expect(res.status).toBe(404);
    });

    it('Phase 3 broadened: status transitions from non-inbox items now succeed (e.g. nextAction → waitingFor)', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.write']);
        // Seed an item directly in nextAction status — patch attempt to transition it elsewhere now succeeds.
        const itemId = '11111111-1111-1111-1111-111111111111';
        await itemsDAO.insertOne({
            _id: itemId,
            user: userId,
            status: ItemStatus.nextAction,
            title: 'already clarified',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        // Transition to waitingFor with a named person (valid under the matrix; person is optional).
        const res = await patch(plaintext, itemId, { status: 'waitingFor', waitingForPersonId: 'p-1' });
        expect(res.status).toBe(200);
        const stored = await itemsDAO.findByOwnerAndId(itemId, userId);
        expect(stored?.status).toBe('waitingFor');
        expect(stored?.waitingForPersonId).toBe('p-1');
    });

    it('accepts PATCH { status: "waitingFor" } with no person — waitingForPersonId is optional', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.write']);
        const id = await createInboxItem(plaintext, 'ext-1');
        const res = await patch(plaintext, id, { status: 'waitingFor' });
        expect(res.status).toBe(200);
        const stored = await itemsDAO.findByOwnerAndId(id, userId);
        expect(stored?.status).toBe('waitingFor');
        expect(stored?.waitingForPersonId).toBeUndefined();
    });

    it('rejects field type errors via Zod (energy / focus / time) with invalid_operation', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.write']);
        const id = await createInboxItem(plaintext, 'ext-1');
        // Phase 3 — Zod validates types, surfaces a single `invalid_operation` code with a path
        // that pinpoints the offending field. The hand-rolled per-field codes are gone.
        const r1 = await patch(plaintext, id, { energy: 'med', status: 'nextAction' });
        const b1 = (await r1.json()) as { code: string; path?: string[] };
        expect(b1.code).toBe('invalid_operation');
        const r2 = await patch(plaintext, id, { focus: 'deep', status: 'nextAction' });
        expect(((await r2.json()) as { code: string }).code).toBe('invalid_operation');
        const r3 = await patch(plaintext, id, { time: -1, status: 'nextAction' });
        expect(((await r3.json()) as { code: string }).code).toBe('invalid_operation');
    });

    // ─── status × field matrix: incompatible-field rejection ────────────────────────
    // Without these checks, callers could PATCH `{status:'somedayMaybe', expectedBy:...}`
    // and the silent-drop sanitizer would discard the field while returning 200. The
    // matrix-aware guard surfaces a 400 with `incompatible_field_for_status` instead.

    // Phase 3 — the Zod-backed matrix validation surfaces violations as
    // `status_field_violation` (the canonical code from `validateOperation`), replacing the
    // legacy hand-rolled `incompatible_field_for_status`. `extra: { status, field }` carries
    // the offending cell so callers can branch on it.
    it('accepts PATCH { status: "somedayMaybe", expectedBy, ignoreBefore } — both deferral dates are allowed', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.write']);
        const id = await createInboxItem(plaintext, 'ext-1');
        const res = await patch(plaintext, id, { status: 'somedayMaybe', expectedBy: '2026-06-01', ignoreBefore: '2026-05-15' });
        expect(res.status).toBe(200);
        const stored = await itemsDAO.findByOwnerAndId(id, userId);
        expect(stored?.status).toBe('somedayMaybe');
        expect(stored?.expectedBy).toBe('2026-06-01');
        expect(stored?.ignoreBefore).toBe('2026-05-15');
    });

    it('rejects PATCH { status: "somedayMaybe", workContextIds } with status_field_violation', async () => {
        // somedayMaybe gained expectedBy/ignoreBefore but still rejects schedule/context fields.
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.write']);
        const id = await createInboxItem(plaintext, 'ext-1');
        const res = await patch(plaintext, id, { status: 'somedayMaybe', workContextIds: ['ctx-1'] });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { code: string; error: string };
        expect(body.code).toBe('status_field_violation');
        expect(body.error).toContain('workContextIds');
        // Item must not have been updated.
        const stored = await itemsDAO.findByOwnerAndId(id, userId);
        expect(stored?.status).toBe('inbox');
    });

    it('rejects PATCH { status: "nextAction", waitingForPersonId } with status_field_violation', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.write']);
        const id = await createInboxItem(plaintext, 'ext-1');
        const res = await patch(plaintext, id, { status: 'nextAction', waitingForPersonId: 'p-1' });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('status_field_violation');
    });

    it('rejects PATCH { status: "waitingFor", energy } with status_field_violation', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.write']);
        const id = await createInboxItem(plaintext, 'ext-1');
        const res = await patch(plaintext, id, { status: 'waitingFor', energy: 'low' });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('status_field_violation');
    });

    it('accepts PATCH { status: "waitingFor", waitingForPersonId, expectedBy } — all allowed', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.write']);
        const id = await createInboxItem(plaintext, 'ext-1');
        const res = await patch(plaintext, id, { status: 'waitingFor', waitingForPersonId: 'p-1', expectedBy: '2026-06-01' });
        expect(res.status).toBe(200);
    });
});

// ─── POST /v1/items/:id/complete — sanitization ─────────────────────────────────
//
// `completeItem` flips status to `done` and the sanitizer strips any status-specific fields
// that don't belong on a `done` item. The resulting snapshot must pass strict-mode validation
// in the shared apply pipeline.

describe('POST /v1/items/:id/complete — preserves historical fields', () => {
    // `done` is archival per the matrix — it keeps the prior status's fields so retrospectives
    // can see what the item looked like at completion. The sanitizer is a no-op for done; only
    // the status flag and updatedTs change.
    it('preserves prior status-specific fields when completing a populated nextAction item', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.write']);
        const itemId = '22222222-2222-2222-2222-222222222222';
        await itemsDAO.insertOne({
            _id: itemId,
            user: userId,
            status: ItemStatus.nextAction,
            title: 'do the thing',
            energy: 'low',
            time: 30,
            workContextIds: ['ctx-1'],
            urgent: true,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });

        const res = await app.fetch(
            new Request(`http://localhost:4000/v1/items/${itemId}/complete`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${plaintext}` },
            }),
        );
        expect(res.status).toBe(200);
        const stored = await itemsDAO.findByOwnerAndId(itemId, userId);
        expect(stored?.status).toBe('done');
        expect(stored?.energy).toBe('low');
        expect(stored?.time).toBe(30);
        expect(stored?.workContextIds).toEqual(['ctx-1']);
        expect(stored?.urgent).toBe(true);
    });
});

describe('Token scopes', () => {
    it('mint with scopes: token carries only the requested capabilities', async () => {
        const userId = await login();
        const { plaintext, record } = await issueApiToken(userId, 'capture-only', ['items.capture']);
        expect(record.scopes).toEqual(['items.capture']);
        // Capture works.
        const create = await app.fetch(
            new Request('http://localhost:4000/v1/items', {
                method: 'POST',
                headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: 't', externalId: 'ext-1' }),
            }),
        );
        expect(create.status).toBe(201);
        // Read does not work.
        const list = await app.fetch(new Request('http://localhost:4000/v1/items', { headers: { Authorization: `Bearer ${plaintext}` } }));
        expect(list.status).toBe(403);
        expect(((await list.json()) as { code: string }).code).toBe('forbidden_scope');
    });

    it('clarify-scoped token can PATCH but not capture-only token', async () => {
        const userId = await login();
        const { plaintext: clarifyToken } = await issueApiToken(userId, 'clarify', ['items.capture', 'items.read', 'items.write']);
        const id = await createInboxItem(clarifyToken, 'ext-1');

        const { plaintext: captureOnly } = await issueApiToken(userId, 'capture', ['items.capture']);
        const r1 = await patch(captureOnly, id, { status: 'nextAction' });
        expect(r1.status).toBe(403);
        expect(((await r1.json()) as { code: string }).code).toBe('forbidden_scope');

        const r2 = await patch(clarifyToken, id, { status: 'nextAction' });
        expect(r2.status).toBe(200);
    });

    it('lazy backfill: a pre-scopes token authenticates and gets default capture+read', async () => {
        const userId = await login();
        // Mint a "legacy" token by issuing one and stripping scopes from the row.
        const { plaintext, record } = await issueApiToken(userId, 'legacy', ['items.capture', 'items.read']);
        await db.collection('apiTokens').updateOne({ _id: record._id }, { $unset: { scopes: '' } });

        // First authenticated call: capture works (default scopes include items.capture), backfill kicks in.
        const create = await app.fetch(
            new Request('http://localhost:4000/v1/items', {
                method: 'POST',
                headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: 't', externalId: 'ext-1' }),
            }),
        );
        expect(create.status).toBe(201);

        // Backfill is fire-and-forget; poll briefly so the assertion isn't racy.
        let scopes: unknown;
        for (let attempt = 0; attempt < 20; attempt++) {
            const row = await apiTokensDAO.findOne({ _id: record._id });
            scopes = row?.scopes;
            if (Array.isArray(scopes)) break;
            await new Promise((r) => setTimeout(r, 25));
        }
        expect(Array.isArray(scopes)).toBe(true);
        expect(scopes).toEqual(['items.capture', 'items.read']);
    });

    it('mint endpoint rejects unknown scopes with invalid_scopes', async () => {
        const sessionCookie = (await oauthLogin(app, 'google')).sessionCookie!;
        const res = await app.fetch(
            new Request('http://localhost:4000/account/tokens', {
                method: 'POST',
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ label: 'x', scopes: ['items.capture', 'admin.everything'] }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_scopes');
    });

    it('mint endpoint rejects empty scopes array with invalid_scopes', async () => {
        const sessionCookie = (await oauthLogin(app, 'google')).sessionCookie!;
        const res = await app.fetch(
            new Request('http://localhost:4000/account/tokens', {
                method: 'POST',
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ label: 'x', scopes: [] }),
            }),
        );
        expect(res.status).toBe(400);
    });
});
