/** PATCH /v1/items/:id (clarify) + token scopes — issue #19 step 7. */
/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import apiTokensDAO from '../dataAccess/apiTokensDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { tokensRoutes } from '../routes/tokens.js';
import { v1ItemsRoutes } from '../routes/v1Items.js';
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
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.clarify']);
        const id = await createInboxItem(plaintext, 'ext-1');

        const res = await patch(plaintext, id, { status: 'nextAction', energy: 'low', time: 5, urgent: true });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; energy: string; time: number; urgent: boolean };
        expect(body.status).toBe('nextAction');
        expect(body.energy).toBe('low');
        expect(body.time).toBe(5);
        expect(body.urgent).toBe(true);
    });

    it('rejects status: calendar (calendar items have a separate creation path)', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.clarify']);
        const id = await createInboxItem(plaintext, 'ext-1');
        const res = await patch(plaintext, id, { status: 'calendar' });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_status');
    });

    it('rejects status: done (use POST /complete)', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.clarify']);
        const id = await createInboxItem(plaintext, 'ext-1');
        const res = await patch(plaintext, id, { status: 'done' });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_status');
    });

    it('rejects forbidden fields (e.g., user, contentHash)', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.clarify']);
        const id = await createInboxItem(plaintext, 'ext-1');
        const res = await patch(plaintext, id, { user: 'someone-else' });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('forbidden_field');
    });

    it('rejects empty bodies with empty_body', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.clarify']);
        const id = await createInboxItem(plaintext, 'ext-1');
        const res = await patch(plaintext, id, {});
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('empty_body');
    });

    it('returns 404 for items that do not exist', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.clarify']);
        const res = await patch(plaintext, '00000000-0000-0000-0000-000000000000', { status: 'nextAction' });
        expect(res.status).toBe(404);
    });

    it('blocks status transitions from non-inbox items with invalid_transition', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.clarify']);
        // Seed an item directly in nextAction status — patch attempt to transition it elsewhere should 409.
        const itemId = '11111111-1111-1111-1111-111111111111';
        await itemsDAO.insertOne({
            _id: itemId,
            user: userId,
            status: ItemStatus.nextAction,
            title: 'already clarified',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        const res = await patch(plaintext, itemId, { status: 'waitingFor' });
        expect(res.status).toBe(409);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_transition');
    });

    it('rejects field type errors (energy / focus / time)', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.clarify']);
        const id = await createInboxItem(plaintext, 'ext-1');
        const r1 = await patch(plaintext, id, { energy: 'med' });
        expect(((await r1.json()) as { code: string }).code).toBe('invalid_energy');
        const r2 = await patch(plaintext, id, { focus: 'deep' });
        expect(((await r2.json()) as { code: string }).code).toBe('invalid_focus');
        const r3 = await patch(plaintext, id, { time: -1 });
        expect(((await r3.json()) as { code: string }).code).toBe('invalid_time');
    });

    // ─── status × field matrix: incompatible-field rejection ────────────────────────
    // Without these checks, callers could PATCH `{status:'somedayMaybe', expectedBy:...}`
    // and the silent-drop sanitizer would discard the field while returning 200. The
    // matrix-aware guard surfaces a 400 with `incompatible_field_for_status` instead.

    it('rejects PATCH { status: "somedayMaybe", expectedBy } — expectedBy not allowed under somedayMaybe', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.clarify']);
        const id = await createInboxItem(plaintext, 'ext-1');
        const res = await patch(plaintext, id, { status: 'somedayMaybe', expectedBy: '2026-06-01' });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { code: string; error: string };
        expect(body.code).toBe('incompatible_field_for_status');
        expect(body.error).toContain('expectedBy');
        // Item must not have been updated.
        const stored = await itemsDAO.findByOwnerAndId(id, userId);
        expect(stored?.status).toBe('inbox');
    });

    it('rejects PATCH { status: "nextAction", waitingForPersonId } — waitingForPersonId not allowed under nextAction', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.clarify']);
        const id = await createInboxItem(plaintext, 'ext-1');
        const res = await patch(plaintext, id, { status: 'nextAction', waitingForPersonId: 'p-1' });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('incompatible_field_for_status');
    });

    it('rejects PATCH { status: "waitingFor", energy } — energy not allowed under waitingFor', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.clarify']);
        const id = await createInboxItem(plaintext, 'ext-1');
        const res = await patch(plaintext, id, { status: 'waitingFor', energy: 'low' });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('incompatible_field_for_status');
    });

    it('accepts PATCH { status: "waitingFor", waitingForPersonId, expectedBy } — all allowed', async () => {
        const userId = await login();
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.clarify']);
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
        const { plaintext } = await issueApiToken(userId, 't', ['items.capture', 'items.read', 'items.clarify']);
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
        const { plaintext: clarifyToken } = await issueApiToken(userId, 'clarify', ['items.capture', 'items.read', 'items.clarify']);
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
