/** PUT /v1/items/:id/brief, the read-only `brief` projection on item responses, the `briefState`
 * list filter, and the itemBrief arm of /v1/operations/batch. */
/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import itemBriefsDAO from '../dataAccess/itemBriefsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import { findBriefTargets } from '../lib/brief/briefTargets.js';
import { briefSourceHash } from '../lib/briefSource.js';
import { BRIEF_MAX_CHARS } from '../lib/itemBriefs.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { v1ItemsRoutes } from '../routes/v1/items.js';
import { v1OperationsRoutes } from '../routes/v1/operations.js';
import type { PublicItem } from '../routes/v1/projections/item.js';
import type { ApiTokenScope, BriefOrigin, ItemBriefInterface, ItemInterface, OperationInterface } from '../types/entities.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono()
    .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
    .route('/v1', v1ItemsRoutes)
    .route('/v1', v1OperationsRoutes);

beforeAll(async () => {
    await loadDataAccess('gtd_test_v1_item_brief');
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
        db.collection('itemBriefs').deleteMany({}),
        db.collection('operations').deleteMany({}),
        db.collection('apiTokens').deleteMany({}),
    ]);
    __resetDefaultStoreForTests();
    vi.restoreAllMocks();
});

async function loginUserId(provider: 'google' | 'github', overrides: Record<string, unknown> = {}): Promise<string> {
    const { sessionCookie } = await oauthLogin(app, provider, overrides);
    const res = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
    const { user } = (await res.json()) as { user: { id: string } };
    return user.id;
}

interface Actor {
    userId: string;
    token: string;
    tokenId: string;
}

async function alice(scopes: ApiTokenScope[] = ['items.read', 'items.write', 'items.capture']): Promise<Actor> {
    const userId = await loginUserId('google');
    const { plaintext, record } = await issueApiToken(userId, 'alice', scopes);
    return { userId, token: plaintext, tokenId: record._id };
}

async function bob(): Promise<Actor> {
    const userId = await loginUserId('github', { email: 'bob@example.com', login: 'bob-gh' });
    const { plaintext, record } = await issueApiToken(userId, 'bob', ['items.read', 'items.write']);
    return { userId, token: plaintext, tokenId: record._id };
}

interface ApiCall {
    method: 'GET' | 'POST' | 'PATCH' | 'PUT';
    path: string;
    token: string;
    body?: unknown;
}

async function call({ method, path, token, body }: ApiCall): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return app.fetch(new Request(`http://localhost:4000${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
}

const TITLE = 'Renew passport';
const NOTES = 'Expires in March; need photos and the old passport. The consulate only takes appointments on weekday mornings.';

async function seedItem(userId: string, overrides: Partial<ItemInterface> = {}): Promise<ItemInterface> {
    const now = dayjs().toISOString();
    const item: ItemInterface = {
        _id: overrides._id ?? `item-${Math.random().toString(36).slice(2)}`,
        user: userId,
        status: 'inbox',
        title: TITLE,
        notes: NOTES,
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
    await itemsDAO.insertOne(item);
    return item;
}

/** The sweep-selection marker, read straight off the collection. */
async function markerOf(itemId: string): Promise<boolean | undefined> {
    return (await db.collection<ItemInterface>('items').findOne({ _id: itemId } as never))?.briefStale;
}

async function seedBrief(item: ItemInterface, origin: BriefOrigin, overrides: Partial<ItemBriefInterface> = {}): Promise<ItemBriefInterface> {
    const now = dayjs().toISOString();
    const brief: ItemBriefInterface = {
        _id: item._id ?? '',
        user: item.user,
        itemId: item._id ?? '',
        text: origin === 'skipped' ? null : `brief for ${item._id}`,
        origin,
        sourceHash: briefSourceHash(item.title, item.notes),
        generatedTs: now,
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
    await itemBriefsDAO.insertOne(brief);
    return brief;
}

async function putBrief(actor: Actor, itemId: string, brief: unknown): Promise<Response> {
    return call({ method: 'PUT', path: `/v1/items/${itemId}/brief`, token: actor.token, body: { brief } });
}

async function briefOps(userId: string): Promise<OperationInterface[]> {
    return db
        .collection('operations')
        .find<OperationInterface>({ user: userId, entityType: 'itemBrief' } as never)
        .toArray();
}

describe('PUT /v1/items/:id/brief', () => {
    it('creates an agent-origin brief hashed from the item current title + notes and returns the projected item', async () => {
        const actor = await alice();
        const item = await seedItem(actor.userId);

        const res = await putBrief(actor, item._id!, '  Passport renewal still blocked on photos  ');
        expect(res.status).toBe(200);
        const body = (await res.json()) as PublicItem;
        expect(body._id).toBe(item._id);
        expect(body.brief).toMatchObject({ text: 'Passport renewal still blocked on photos', origin: 'agent', state: 'fresh' });
        expect(dayjs(body.brief?.generatedTs).isValid()).toBe(true);

        const stored = await itemBriefsDAO.findByOwnerAndId(item._id!, actor.userId);
        expect(stored).toMatchObject({ itemId: item._id, user: actor.userId, origin: 'agent', sourceHash: briefSourceHash(item.title, item.notes) });
        expect(stored?.model).toBeUndefined();

        const ops = await briefOps(actor.userId);
        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ opType: 'create', entityId: item._id, deviceId: `api:${actor.tokenId}` });
    });

    it('a second PUT updates in place (update op, createdTs preserved, generatedTs refreshed)', async () => {
        const actor = await alice();
        const item = await seedItem(actor.userId);
        await putBrief(actor, item._id!, 'first');
        const first = await itemBriefsDAO.findByOwnerAndId(item._id!, actor.userId);

        const res = await putBrief(actor, item._id!, 'second');
        expect(res.status).toBe(200);
        const stored = await itemBriefsDAO.findByOwnerAndId(item._id!, actor.userId);
        expect(stored?.text).toBe('second');
        expect(stored?.createdTs).toBe(first?.createdTs);
        expect(stored?.generatedTs >= first!.generatedTs).toBe(true);
        expect((await briefOps(actor.userId)).map((op) => op.opType)).toEqual(['create', 'update']);
    });

    it('PUT null deletes the row with a recorded delete op and returns brief: null', async () => {
        const actor = await alice();
        const item = await seedItem(actor.userId);
        await putBrief(actor, item._id!, 'to be cleared');

        const res = await putBrief(actor, item._id!, null);
        expect(res.status).toBe(200);
        expect(((await res.json()) as PublicItem).brief).toBeNull();
        expect(await itemBriefsDAO.findByOwnerAndId(item._id!, actor.userId)).toBeNull();
        expect((await briefOps(actor.userId)).map((op) => op.opType)).toEqual(['create', 'delete']);
    });

    it('PUT null leaves the item SELECTABLE again — clearing a brief must not strand it', async () => {
        // `briefStale` answers a question about the itemBriefs SIDECAR, but the DAO choke point
        // that maintains it only sees writes to `items`. Removing a brief is the user-facing
        // gesture for exactly that, so without an explicit re-mark a settled item ends up with no
        // brief row AND no marker — invisible to every future sweep until its content changes.
        const actor = await alice();
        const item = await seedItem(actor.userId);
        await putBrief(actor, item._id!, 'to be cleared');
        // Authoring settles nothing by itself, so drive the item to the settled steady state first.
        await itemsDAO.clearBriefStale(item._id!, actor.userId, { title: TITLE, notes: NOTES, status: 'inbox' });
        expect(await markerOf(item._id!)).toBe(false);

        await putBrief(actor, item._id!, null);

        expect(await markerOf(item._id!)).toBe(true);
        expect((await findBriefTargets(10)).map((target) => target.item._id)).toContain(item._id);
    });

    it('authoring a brief marks the item, so unpinning it later cannot strand it', async () => {
        const actor = await alice();
        const item = await seedItem(actor.userId);
        await itemsDAO.clearBriefStale(item._id!, actor.userId, { title: TITLE, notes: NOTES, status: 'inbox' });
        await putBrief(actor, item._id!, 'mine');
        expect(await markerOf(item._id!)).toBe(true);
        // Still not a target while it stays pinned — the marker only makes it visible, the hash
        // comparison keeps refusing to replace an authored brief.
        expect(await findBriefTargets(10)).toEqual([]);
    });

    it('PUT null on an item without a brief is a no-op (no op recorded)', async () => {
        const actor = await alice();
        const item = await seedItem(actor.userId);
        const res = await putBrief(actor, item._id!, null);
        expect(res.status).toBe(200);
        expect(await briefOps(actor.userId)).toEqual([]);
    });

    it("404s for another user's item and for a missing item, writing nothing", async () => {
        const actor = await alice();
        const other = await bob();
        const bobsItem = await seedItem(other.userId);
        expect((await putBrief(actor, bobsItem._id!, 'mine now')).status).toBe(404);
        expect((await putBrief(actor, 'does-not-exist', 'x')).status).toBe(404);
        expect(await db.collection('itemBriefs').countDocuments({})).toBe(0);
    });

    it.each([
        ['empty string', ''],
        ['whitespace only', '   \n '],
        ['over the cap', 'x'.repeat(BRIEF_MAX_CHARS + 1)],
        ['a number', 42],
    ])('400s %s', async (_label, brief) => {
        const actor = await alice();
        const item = await seedItem(actor.userId);
        const res = await putBrief(actor, item._id!, brief);
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_brief');
    });

    it('400s a body without the brief key and a non-object body', async () => {
        const actor = await alice();
        const item = await seedItem(actor.userId);
        const noKey = await call({ method: 'PUT', path: `/v1/items/${item._id}/brief`, token: actor.token, body: { text: 'x' } });
        expect(noKey.status).toBe(400);
        expect(((await noKey.json()) as { code: string }).code).toBe('invalid_body');
        const array = await call({ method: 'PUT', path: `/v1/items/${item._id}/brief`, token: actor.token, body: ['x'] });
        expect(array.status).toBe(400);
    });

    it('accepts exactly BRIEF_MAX_CHARS characters', async () => {
        const actor = await alice();
        const item = await seedItem(actor.userId);
        expect((await putBrief(actor, item._id!, 'y'.repeat(BRIEF_MAX_CHARS))).status).toBe(200);
    });

    it('403s a token without items.write', async () => {
        const actor = await alice(['items.read']);
        const item = await seedItem(actor.userId);
        expect((await putBrief(actor, item._id!, 'x')).status).toBe(403);
    });
});

describe('brief projection on item reads', () => {
    it('GET /v1/items/:id carries brief: null when there is no row', async () => {
        const actor = await alice();
        const item = await seedItem(actor.userId);
        const res = await call({ method: 'GET', path: `/v1/items/${item._id}`, token: actor.token });
        const body = (await res.json()) as PublicItem;
        expect(body.brief).toBeNull();
        expect('brief' in body).toBe(true);
    });

    it('exposes only text/origin/state/generatedTs — never sourceHash, user or itemId', async () => {
        const actor = await alice();
        const item = await seedItem(actor.userId);
        await seedBrief(item, 'user');
        const res = await call({ method: 'GET', path: `/v1/items/${item._id}`, token: actor.token });
        const { brief } = (await res.json()) as PublicItem;
        expect(Object.keys(brief ?? {}).sort()).toEqual(['generatedTs', 'origin', 'state', 'text']);
    });

    it('a PATCH that changes the notes flips an authored brief to pinnedStale in the same response', async () => {
        const actor = await alice();
        const item = await seedItem(actor.userId);
        await putBrief(actor, item._id!, 'authored');
        const res = await call({ method: 'PATCH', path: `/v1/items/${item._id}`, token: actor.token, body: { notes: `${NOTES} Also: bring cash.` } });
        expect(res.status).toBe(200);
        expect(((await res.json()) as PublicItem).brief).toMatchObject({ text: 'authored', origin: 'agent', state: 'pinnedStale' });
    });

    it('a model brief whose source moved on reads as state none', async () => {
        const actor = await alice();
        const stale = await seedItem(actor.userId);
        await seedBrief(stale, 'model', { sourceHash: 'stale', model: 'claude-haiku-4-5' });

        const staleRes = (await (await call({ method: 'GET', path: `/v1/items/${stale._id}`, token: actor.token })).json()) as PublicItem;
        expect(staleRes.brief).toMatchObject({ origin: 'model', state: 'none' });
    });

    it('projects state declined for both text-less origins recorded against the current text', async () => {
        const actor = await alice();
        const skipped = await seedItem(actor.userId, { notes: 'short' });
        await seedBrief(skipped, 'skipped');
        // The model read long notes and returned null — a valid result, not a failure.
        const declinedByModel = await seedItem(actor.userId);
        await seedBrief(declinedByModel, 'model', { text: null, model: 'claude-haiku-4-5' });

        const skippedRes = (await (await call({ method: 'GET', path: `/v1/items/${skipped._id}`, token: actor.token })).json()) as PublicItem;
        expect(skippedRes.brief).toMatchObject({ origin: 'skipped', state: 'declined', text: null });
        const modelRes = (await (await call({ method: 'GET', path: `/v1/items/${declinedByModel._id}`, token: actor.token })).json()) as PublicItem;
        expect(modelRes.brief).toMatchObject({ origin: 'model', state: 'declined', text: null });
    });

    it('a text-less row whose source moved on lapses back to none', async () => {
        const actor = await alice();
        const item = await seedItem(actor.userId, { notes: 'short' });
        await seedBrief(item, 'skipped', { sourceHash: 'stale' });
        const res = (await (await call({ method: 'GET', path: `/v1/items/${item._id}`, token: actor.token })).json()) as PublicItem;
        expect(res.brief).toMatchObject({ origin: 'skipped', state: 'none', text: null });
    });

    it('POST /v1/items (fresh capture) returns brief: null', async () => {
        const actor = await alice();
        const res = await call({ method: 'POST', path: '/v1/items', token: actor.token, body: { title: 'new' } });
        expect(res.status).toBe(201);
        expect(((await res.json()) as PublicItem).brief).toBeNull();
    });
});

describe('GET /v1/items?briefState=', () => {
    async function seedThreeStates(actor: Actor) {
        const fresh = await seedItem(actor.userId, { _id: 'fresh' });
        await seedBrief(fresh, 'model');
        const pinnedStale = await seedItem(actor.userId, { _id: 'pinned-stale' });
        await seedBrief(pinnedStale, 'user', { sourceHash: 'stale' });
        const modelStale = await seedItem(actor.userId, { _id: 'model-stale' });
        await seedBrief(modelStale, 'model', { sourceHash: 'stale' });
        await seedItem(actor.userId, { _id: 'bare' });
        const skipped = await seedItem(actor.userId, { _id: 'skipped', notes: 'short' });
        await seedBrief(skipped, 'skipped');
        // The model looked at exactly this text and wrote no brief — `declined`, not `none`.
        const declined = await seedItem(actor.userId, { _id: 'declined' });
        await seedBrief(declined, 'model', { text: null });
        // A skipped row whose notes moved on: renders `none`, but the `none` FILTER still
        // excludes it (see matchesBriefStateFilter) so an external sweep does not reselect it.
        const skippedStale = await seedItem(actor.userId, { _id: 'skipped-stale', notes: 'short' });
        await seedBrief(skippedStale, 'skipped', { sourceHash: 'stale' });
    }

    async function listIds(actor: Actor, query: string): Promise<{ ids: string[]; nextCursor?: string }> {
        const res = await call({ method: 'GET', path: `/v1/items${query}`, token: actor.token });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: PublicItem[]; nextCursor?: string };
        return { ids: body.items.map((item) => item._id ?? '').sort(), ...(body.nextCursor ? { nextCursor: body.nextCursor } : {}) };
    }

    it('lists every item with its brief (one query per page) when unfiltered', async () => {
        const actor = await alice();
        await seedThreeStates(actor);
        const findArray = vi.spyOn(itemBriefsDAO, 'findArray');
        const res = await call({ method: 'GET', path: '/v1/items', token: actor.token });
        const body = (await res.json()) as { items: PublicItem[] };
        expect(body.items.map((item) => [item._id, item.brief?.state ?? 'no-row']).sort()).toEqual([
            ['bare', 'no-row'],
            ['declined', 'declined'],
            ['fresh', 'fresh'],
            ['model-stale', 'none'],
            ['pinned-stale', 'pinnedStale'],
            ['skipped', 'declined'],
            ['skipped-stale', 'none'],
        ]);
        expect(findArray).toHaveBeenCalledTimes(1);
    });

    // `none` deliberately EXCLUDES every `skipped` row — including `skipped-stale`, whose state
    // now reads `none`: the sweeper's recorded "notes too short" decision must not be reselected.
    it.each([
        ['fresh', ['fresh']],
        ['pinnedStale', ['pinned-stale']],
        ['declined', ['declined', 'skipped']],
        ['none', ['bare', 'model-stale']],
    ])('briefState=%s keeps %j', async (state, expected) => {
        const actor = await alice();
        await seedThreeStates(actor);
        expect((await listIds(actor, `?briefState=${state}`)).ids).toEqual(expected);
    });

    it('is a per-page post-filter: the cursor advances over the unfiltered page', async () => {
        const actor = await alice();
        await seedThreeStates(actor);
        // limit=2 → each page holds two of the seeded items; the filter may empty a page, but the
        // cursor still points past both so the caller can keep paginating to the single match.
        const first = await listIds(actor, '?briefState=fresh&limit=2');
        expect(first.nextCursor).toBeDefined();
        const collected = [...first.ids];
        // Walk to exhaustion rather than a fixed page count, so seeding another state cannot
        // silently truncate the walk and turn a real regression into a passing assertion.
        let cursor = first.nextCursor;
        while (cursor) {
            const page = await listIds(actor, `?briefState=fresh&limit=2&cursor=${cursor}`);
            collected.push(...page.ids);
            cursor = page.nextCursor;
        }
        expect(collected).toEqual(['fresh']);
    });

    it('400s an unknown briefState', async () => {
        const actor = await alice();
        const res = await call({ method: 'GET', path: '/v1/items?briefState=stale', token: actor.token });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_brief_state');
    });
});

describe('POST /v1/operations/batch — itemBrief ops', () => {
    const NOW = '2026-04-01T00:00:00.000Z';

    function briefSnapshot(item: ItemInterface, origin: BriefOrigin, extra: Record<string, unknown> = {}) {
        return {
            _id: item._id,
            user: item.user,
            itemId: item._id,
            text: 'batch brief',
            origin,
            sourceHash: briefSourceHash(item.title, item.notes),
            generatedTs: NOW,
            createdTs: NOW,
            updatedTs: NOW,
            ...extra,
        };
    }

    async function batch(actor: Actor, ops: unknown[]): Promise<Response> {
        return call({ method: 'POST', path: '/v1/operations/batch', token: actor.token, body: { ops } });
    }

    it.each(['user', 'agent'] as const)('accepts a %s-origin create and persists the row under items.write', async (origin) => {
        const actor = await alice();
        const item = await seedItem(actor.userId);
        const res = await batch(actor, [{ entityType: 'itemBrief', opType: 'create', entityId: item._id, snapshot: briefSnapshot(item, origin) }]);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { results: Array<{ applyStatus: string }> };
        expect(body.results[0]?.applyStatus).toBe('applied');
        expect(await itemBriefsDAO.findByOwnerAndId(item._id!, actor.userId)).toMatchObject({ origin, text: 'batch brief' });
    });

    it.each(['model', 'skipped'] as const)('rejects the server-only %s origin with 400 forbidden_origin before any write', async (origin) => {
        const actor = await alice();
        const item = await seedItem(actor.userId);
        const res = await batch(actor, [
            { entityType: 'itemBrief', opType: 'create', entityId: item._id, snapshot: briefSnapshot(item, origin, { text: null }) },
        ]);
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('forbidden_origin');
        expect(await db.collection('itemBriefs').countDocuments({})).toBe(0);
    });

    it('rejects the server-managed model field with 400 forbidden_field', async () => {
        const actor = await alice();
        const item = await seedItem(actor.userId);
        const res = await batch(actor, [
            { entityType: 'itemBrief', opType: 'create', entityId: item._id, snapshot: briefSnapshot(item, 'agent', { model: 'x' }) },
        ]);
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('forbidden_field');
    });

    it('rejects an itemId that disagrees with entityId with 400', async () => {
        const actor = await alice();
        const item = await seedItem(actor.userId);
        const res = await batch(actor, [
            { entityType: 'itemBrief', opType: 'create', entityId: item._id, snapshot: briefSnapshot(item, 'agent', { itemId: 'other' }) },
        ]);
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_op_shape');
    });

    it("404s a brief for a missing item or another user's item, writing nothing from the batch", async () => {
        const actor = await alice();
        const other = await bob();
        const bobsItem = await seedItem(other.userId);
        const mine = await seedItem(actor.userId);
        const res = await batch(actor, [
            { entityType: 'itemBrief', opType: 'create', entityId: mine._id, snapshot: briefSnapshot(mine, 'agent') },
            { entityType: 'itemBrief', opType: 'create', entityId: bobsItem._id, snapshot: briefSnapshot({ ...bobsItem, user: actor.userId }, 'agent') },
        ]);
        expect(res.status).toBe(404);
        expect(((await res.json()) as { code: string; entityId: string }).entityId).toBe(bobsItem._id);
        expect(await db.collection('itemBriefs').countDocuments({})).toBe(0);
    });

    it('accepts a brief for an item created earlier in the same batch', async () => {
        const actor = await alice();
        const item: ItemInterface = { _id: 'same-batch', user: actor.userId, status: 'inbox', title: TITLE, notes: NOTES, createdTs: NOW, updatedTs: NOW };
        const res = await batch(actor, [
            { entityType: 'item', opType: 'create', entityId: item._id, snapshot: item },
            { entityType: 'itemBrief', opType: 'create', entityId: item._id, snapshot: briefSnapshot(item, 'agent') },
        ]);
        expect(res.status).toBe(200);
        expect(await itemsDAO.findByOwnerAndId('same-batch', actor.userId)).not.toBeNull();
        expect(await itemBriefsDAO.findByOwnerAndId('same-batch', actor.userId)).toMatchObject({ origin: 'agent' });
        const read = (await (await call({ method: 'GET', path: '/v1/items/same-batch', token: actor.token })).json()) as PublicItem;
        expect(read.brief?.state).toBe('fresh');
    });

    it('a delete op removes the row without requiring the item to exist', async () => {
        const actor = await alice();
        const item = await seedItem(actor.userId);
        await seedBrief(item, 'user');
        await itemsDAO.deleteByOwner(item._id!, actor.userId);
        const res = await batch(actor, [{ entityType: 'itemBrief', opType: 'delete', entityId: item._id, snapshot: null }]);
        expect(res.status).toBe(200);
        expect(await itemBriefsDAO.findByOwnerAndId(item._id!, actor.userId)).toBeNull();
    });

    it('403s a token lacking items.write, naming the scope', async () => {
        const actor = await alice(['items.read', 'items.capture']);
        const item = await seedItem(actor.userId);
        const res = await batch(actor, [{ entityType: 'itemBrief', opType: 'create', entityId: item._id, snapshot: briefSnapshot(item, 'agent') }]);
        expect(res.status).toBe(403);
        expect(((await res.json()) as { requiredScope: string }).requiredScope).toBe('items.write');
    });
});
