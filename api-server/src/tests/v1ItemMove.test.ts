import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import { compareByRank } from '../lib/itemMove.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { v1ItemsRoutes } from '../routes/v1/items.js';
import type { DeviceSyncStateInterface, ItemInterface, OperationInterface } from '../types/entities.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/v1', v1ItemsRoutes);

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all(
        ['user', 'session', 'account', 'verification', 'items', 'operations', 'apiTokens', 'deviceSyncState'].map((name) => db.collection(name).deleteMany({})),
    );
    __resetDefaultStoreForTests();
});

interface Caller {
    userId: string;
    token: string;
}

async function signedInUserId(): Promise<string> {
    const { sessionCookie } = await oauthLogin(app, 'google');
    const res = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
    const { user } = (await res.json()) as { user: { id: string } };
    return user.id;
}

async function newCaller(scopes: Parameters<typeof issueApiToken>[2] = ['items.read', 'items.write']): Promise<Caller> {
    const userId = await signedInUserId();
    const { plaintext } = await issueApiToken(userId, 'move-test', scopes);
    return { userId, token: plaintext };
}

async function moveRequest(caller: Caller, itemId: string, body: unknown): Promise<Response> {
    return app.fetch(
        new Request(`http://localhost:4000/v1/items/${itemId}/move`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${caller.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
    );
}

type SeedFields = Partial<Pick<ItemInterface, 'status' | 'rank' | 'expectedBy' | 'createdTs' | 'updatedTs' | 'notes' | 'ignoreBefore'>>;

async function seedItem(userId: string, title: string, fields: SeedFields = {}): Promise<string> {
    const now = dayjs().toISOString();
    const _id = randomUUID();
    const item: ItemInterface = { _id, user: userId, title, status: 'nextAction', createdTs: now, updatedTs: now, ...fields };
    await itemsDAO.insertOne(item);
    return _id;
}

/** Seeds ranked nextAction rows in the given order, returning their ids by title. */
async function seedRanked(userId: string, titles: readonly string[], fields: SeedFields = {}): Promise<Record<string, string>> {
    const entries = await Promise.all(titles.map(async (title, idx) => [title, await seedItem(userId, title, { rank: `a${idx}`, ...fields })] as const));
    return Object.fromEntries(entries);
}

/** Titles of the user's rows of one status (+ optional day) in display order. */
async function orderOf(userId: string, filter: Partial<Pick<ItemInterface, 'status' | 'expectedBy'>> = { status: 'nextAction' }): Promise<string[]> {
    const rows = await itemsDAO.findArray({ user: userId, ...filter });
    return rows
        .flatMap((row) => (row._id ? [{ ...row, _id: row._id }] : []))
        .sort(compareByRank)
        .map((row) => row.title);
}

function opsFor(itemId: string) {
    return db.collection<OperationInterface>('operations').find({ entityId: itemId }).toArray();
}

function idOf(ids: Record<string, string>, title: string): string {
    const id = ids[title];
    if (!id) throw new Error(`no seeded item titled ${title}`);
    return id;
}

describe('POST /v1/items/:id/move — positions', () => {
    it.each([
        [{ position: 'top' }, ['C', 'A', 'B', 'D']],
        [{ position: 'bottom' }, ['A', 'B', 'D', 'C']],
    ])('moves an item to %j of its section', async (body, expected) => {
        const caller = await newCaller();
        const ids = await seedRanked(caller.userId, ['A', 'B', 'C', 'D']);
        const res = await moveRequest(caller, idOf(ids, 'C'), body);
        expect(res.status).toBe(200);
        expect(await orderOf(caller.userId)).toEqual(expected);
    });

    it('moves an item before and after a named item', async () => {
        const caller = await newCaller();
        const ids = await seedRanked(caller.userId, ['A', 'B', 'C', 'D']);
        await moveRequest(caller, idOf(ids, 'D'), { before: idOf(ids, 'B') });
        expect(await orderOf(caller.userId)).toEqual(['A', 'D', 'B', 'C']);
        await moveRequest(caller, idOf(ids, 'A'), { after: idOf(ids, 'C') });
        expect(await orderOf(caller.userId)).toEqual(['D', 'B', 'C', 'A']);
    });

    it('returns the moved item with its new rank and its placement in the section', async () => {
        const caller = await newCaller();
        const ids = await seedRanked(caller.userId, ['A', 'B', 'C']);
        const res = await moveRequest(caller, idOf(ids, 'A'), { after: idOf(ids, 'B') });
        const body = (await res.json()) as { _id: string; rank: string; placement: { position: number; total: number } };
        const stored = await itemsDAO.findByOwnerAndId(idOf(ids, 'A'), caller.userId);
        expect(body._id).toBe(idOf(ids, 'A'));
        expect(body.rank).toBe(stored?.rank);
        expect(body.placement).toEqual({ position: 2, total: 3 });
    });

    it('records one update op for the moved row so devices pull the new order', async () => {
        const caller = await newCaller();
        const ids = await seedRanked(caller.userId, ['A', 'B', 'C']);
        await moveRequest(caller, idOf(ids, 'C'), { position: 'top' });
        const ops = await opsFor(idOf(ids, 'C'));
        expect(ops.map((op) => op.opType)).toEqual(['update']);
        expect(await opsFor(idOf(ids, 'A'))).toHaveLength(0);
    });

    it('writes nothing when the item already sits there', async () => {
        const caller = await newCaller();
        const ids = await seedRanked(caller.userId, ['A', 'B']);
        const res = await moveRequest(caller, idOf(ids, 'A'), { position: 'top' });
        expect(res.status).toBe(200);
        expect(res.headers.get('X-Idempotent-Replay')).toBe('true');
        expect(await opsFor(idOf(ids, 'A'))).toHaveLength(0);
    });

    it('ranks unranked rows of the section when the slot needs it, recording an op for each re-keyed row', async () => {
        const caller = await newCaller();
        const ids = await seedRanked(caller.userId, ['A', 'B']);
        const fresh = await seedItem(caller.userId, 'Fresh');
        expect(await orderOf(caller.userId)).toEqual(['Fresh', 'A', 'B']);
        await moveRequest(caller, idOf(ids, 'B'), { position: 'top' });
        expect(await orderOf(caller.userId)).toEqual(['B', 'Fresh', 'A']);
        expect((await itemsDAO.findByOwnerAndId(fresh, caller.userId))?.rank).toBeDefined();
        expect(await opsFor(fresh)).toHaveLength(1);
    });
});

describe('POST /v1/items/:id/move — sections', () => {
    it('only reorders inside the item’s expected day, leaving other days untouched', async () => {
        const caller = await newCaller();
        const today = await seedRanked(caller.userId, ['T1', 'T2'], { expectedBy: '2026-11-02' });
        const other = await seedItem(caller.userId, 'Other day', { rank: 'Zz', expectedBy: '2026-11-03' });
        await moveRequest(caller, idOf(today, 'T2'), { position: 'top' });
        expect(await orderOf(caller.userId, { status: 'nextAction', expectedBy: '2026-11-02' })).toEqual(['T2', 'T1']);
        expect(await opsFor(other)).toHaveLength(0);
    });

    it("groups datetime expectedBy values by the user's reported timezone", async () => {
        const caller = await newCaller();
        // 03:00Z on the 3rd is the evening of the 2nd in New York — the same section as a date-only 2026-11-02.
        await db.collection<DeviceSyncStateInterface>('deviceSyncState').insertOne({
            _id: `dev::${caller.userId}`,
            deviceId: 'dev',
            user: caller.userId,
            lastSyncedTs: dayjs().toISOString(),
            lastSyncedId: '',
            lastSeenTs: dayjs().toISOString(),
            timezone: 'America/New_York',
            timezoneReportedTs: dayjs().toISOString(),
        });
        const dateOnly = await seedItem(caller.userId, 'Date only', { rank: 'a0', expectedBy: '2026-11-02' });
        const evening = await seedItem(caller.userId, 'Evening', { rank: 'a1', expectedBy: '2026-11-03T03:00:00.000Z' });
        const res = await moveRequest(caller, evening, { before: dateOnly });
        expect(res.status).toBe(200);
        const rows = await itemsDAO.findArray({ user: caller.userId });
        const [first] = rows.flatMap((row) => (row._id ? [{ ...row, _id: row._id }] : [])).sort(compareByRank);
        expect(first?.title).toBe('Evening');
    });

    it('reorders the inbox and Someday / Maybe as flat lists', async () => {
        const caller = await newCaller();
        const inbox = await seedRanked(caller.userId, ['I1', 'I2', 'I3'], { status: 'inbox' });
        await moveRequest(caller, idOf(inbox, 'I3'), { position: 'top' });
        expect(await orderOf(caller.userId, { status: 'inbox' })).toEqual(['I3', 'I1', 'I2']);
        const someday = await seedRanked(caller.userId, ['S1', 'S2'], { status: 'somedayMaybe' });
        await moveRequest(caller, idOf(someday, 'S1'), { position: 'bottom' });
        expect(await orderOf(caller.userId, { status: 'somedayMaybe' })).toEqual(['S2', 'S1']);
    });

    it('rejects an anchor in another section with 409 different_section', async () => {
        const caller = await newCaller();
        const moved = await seedItem(caller.userId, 'Moved', { rank: 'a0', expectedBy: '2026-11-02' });
        const anchor = await seedItem(caller.userId, 'Anchor', { rank: 'a1', expectedBy: '2026-11-03' });
        const res = await moveRequest(caller, moved, { after: anchor });
        expect(res.status).toBe(409);
        expect(((await res.json()) as { code: string }).code).toBe('different_section');
    });

    it.each(['calendar', 'done', 'trash'] as const)('rejects moving a %s item with 409 not_orderable', async (status) => {
        const caller = await newCaller();
        const id = await seedItem(caller.userId, 'x', { status });
        const res = await moveRequest(caller, id, { position: 'top' });
        expect(res.status).toBe(409);
        expect(((await res.json()) as { code: string }).code).toBe('not_orderable');
    });
});

describe('POST /v1/items/:id/move — what it writes', () => {
    it('records the new rank on the op as applied', async () => {
        const caller = await newCaller();
        const ids = await seedRanked(caller.userId, ['A', 'B']);
        await moveRequest(caller, idOf(ids, 'B'), { position: 'top' });
        const stored = await itemsDAO.findByOwnerAndId(idOf(ids, 'B'), caller.userId);
        const [op] = await opsFor(idOf(ids, 'B'));
        if (!op) throw new Error('expected one op');
        expect(op.snapshot).toMatchObject({ rank: stored?.rank });
        expect(op.notApplied).toBeUndefined();
    });

    it('keeps every other field of a re-keyed neighbour', async () => {
        const caller = await newCaller();
        const ids = await seedRanked(caller.userId, ['A', 'B']);
        const fresh = await seedItem(caller.userId, 'Fresh', { notes: 'keep me', ignoreBefore: '2020-01-01' });
        const before = await itemsDAO.findByOwnerAndId(fresh, caller.userId);
        await moveRequest(caller, idOf(ids, 'B'), { position: 'top' });
        const after = await itemsDAO.findByOwnerAndId(fresh, caller.userId);
        const { rank, updatedTs, ...rest } = after ?? {};
        const { rank: _oldRank, updatedTs: _oldTs, ...restBefore } = before ?? {};
        expect(rank).toBeDefined();
        expect(rest).toEqual(restBefore);
    });

    it('counts tickler-hidden rows in the section and keeps their place', async () => {
        const caller = await newCaller();
        const ids = await seedRanked(caller.userId, ['A', 'B']);
        const hidden = await seedItem(caller.userId, 'Hidden', { rank: 'a0V', ignoreBefore: dayjs().add(30, 'day').format('YYYY-MM-DD') });
        const res = await moveRequest(caller, idOf(ids, 'B'), { position: 'top' });
        const body = (await res.json()) as { placement: { position: number; total: number } };
        expect(body.placement).toEqual({ position: 1, total: 3 });
        expect(await orderOf(caller.userId)).toEqual(['B', 'A', 'Hidden']);
        expect(await opsFor(hidden)).toHaveLength(0);
    });

    it('serializes parallel moves of one user: every key stays distinct and each move reports a real top slot', async () => {
        const caller = await newCaller();
        const ids = await seedRanked(caller.userId, ['A', 'B', 'C', 'D']);
        // Arrival order at the lock depends on async auth, so which of B/C/D ends highest is not pinned.
        const responses = await Promise.all(['B', 'C', 'D'].map((title) => moveRequest(caller, idOf(ids, title), { position: 'top' })));
        const ranks = (await itemsDAO.findArray({ user: caller.userId })).map((row) => row.rank);
        expect(new Set(ranks).size).toBe(4);
        expect((await orderOf(caller.userId)).at(-1)).toBe('A');
        expect(responses.map((res) => res.status)).toEqual([200, 200, 200]);
    });

    it('answers 409 item_changed when the store refuses the write (a newer edit already landed)', async () => {
        const caller = await newCaller();
        await seedItem(caller.userId, 'A', { rank: 'a0' });
        // The future updatedTs only forces the store to refuse the write (sync paths clamp such stamps); the
        // real trigger is a device edit landing between the section read and the write, which cannot be staged here.
        const ahead = await seedItem(caller.userId, 'Ahead', { rank: 'a5', updatedTs: dayjs().add(1, 'hour').toISOString() });
        const res = await moveRequest(caller, ahead, { position: 'top' });
        expect(res.status).toBe(409);
        expect(((await res.json()) as { code: string }).code).toBe('item_changed');
        expect(await orderOf(caller.userId)).toEqual(['A', 'Ahead']);
    });
});

describe('POST /v1/items/:id/move — errors', () => {
    it.each(['done', 'calendar'] as const)('409s different_section when the anchor is %s', async (status) => {
        const caller = await newCaller();
        const moved = await seedItem(caller.userId, 'Moved', { rank: 'a0' });
        const anchor = await seedItem(caller.userId, 'Anchor', { status });
        const res = await moveRequest(caller, moved, { before: anchor });
        expect(res.status).toBe(409);
        expect(((await res.json()) as { code: string }).code).toBe('different_section');
    });

    it('404s for an unknown item and for another user’s item', async () => {
        const caller = await newCaller();
        const foreign = await seedItem('someone-else', 'theirs');
        for (const id of ['nope', foreign]) {
            const res = await moveRequest(caller, id, { position: 'top' });
            expect(res.status).toBe(404);
            expect(((await res.json()) as { code: string }).code).toBe('not_found');
        }
    });

    it('404s anchor_not_found when the anchor does not exist or is someone else’s', async () => {
        const caller = await newCaller();
        const moved = await seedItem(caller.userId, 'Moved', { rank: 'a0' });
        const foreign = await seedItem('someone-else', 'theirs', { rank: 'a1' });
        for (const anchor of ['missing', foreign]) {
            const res = await moveRequest(caller, moved, { before: anchor });
            expect(res.status).toBe(404);
            expect(((await res.json()) as { code: string }).code).toBe('anchor_not_found');
        }
    });

    it('400s invalid_anchor when the anchor is the item itself', async () => {
        const caller = await newCaller();
        const moved = await seedItem(caller.userId, 'Moved', { rank: 'a0' });
        const res = await moveRequest(caller, moved, { after: moved });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_anchor');
    });

    it('400s invalid_body for a malformed body', async () => {
        const caller = await newCaller();
        const moved = await seedItem(caller.userId, 'Moved', { rank: 'a0' });
        const res = await moveRequest(caller, moved, { position: 'top', before: moved });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_body');
    });

    it('requires the items.write scope', async () => {
        const caller = await newCaller(['items.read']);
        const moved = await seedItem(caller.userId, 'Moved', { rank: 'a0' });
        expect((await moveRequest(caller, moved, { position: 'top' })).status).toBe(403);
    });
});
