import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { issueApiToken } from '../auth/apiTokens.js';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { v1ItemsRoutes } from '../routes/v1/items.js';
import type { ItemInterface } from '../types/entities.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/v1', v1ItemsRoutes);

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all(['user', 'session', 'account', 'verification', 'items', 'operations', 'apiTokens'].map((name) => db.collection(name).deleteMany({})));
    __resetDefaultStoreForTests();
});

interface Caller {
    userId: string;
    token: string;
}

async function newCaller(): Promise<Caller> {
    const { sessionCookie } = await oauthLogin(app, 'google');
    const res = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
    const { user } = (await res.json()) as { user: { id: string } };
    const { plaintext } = await issueApiToken(user.id, 'priority-test', ['items.read']);
    return { userId: user.id, token: plaintext };
}

interface ListResponse {
    items: Array<{ title: string }>;
    nextCursor?: string;
}

async function list(caller: Caller, query: string): Promise<Response> {
    return app.fetch(new Request(`http://localhost:4000/v1/items?${query}`, { headers: { Authorization: `Bearer ${caller.token}` } }));
}

async function titlesOf(caller: Caller, query: string): Promise<string[]> {
    const res = await list(caller, query);
    expect(res.status).toBe(200);
    return ((await res.json()) as ListResponse).items.map((row) => row.title);
}

type SeedFields = Partial<Omit<ItemInterface, '_id' | 'user' | 'title'>> & Pick<ItemInterface, 'status'>;

async function seed(userId: string, title: string, fields: SeedFields): Promise<void> {
    const now = dayjs().toISOString();
    await itemsDAO.insertOne({ _id: randomUUID(), user: userId, title, createdTs: now, updatedTs: now, ...fields });
}

/** One row per list, seeded so the updatedTs order is the REVERSE of the priority order. */
async function seedEveryList(userId: string): Promise<void> {
    const at = (minutes: number) => dayjs().subtract(minutes, 'minute').toISOString();
    const snoozedUntil = dayjs().add(30, 'day').format('YYYY-MM-DD');
    await seed(userId, 'Inbox', { status: 'inbox', rank: 'a0', updatedTs: at(80), notes: 'full row' });
    await seed(userId, 'Next today', { status: 'nextAction', rank: 'a1', expectedBy: '2026-11-02', updatedTs: at(70) });
    await seed(userId, 'Next undated', { status: 'nextAction', rank: 'a0', updatedTs: at(60) });
    await seed(userId, 'Meeting', { status: 'calendar', timeStart: '2026-11-03T10:00:00', timeEnd: '2026-11-03T11:00:00', updatedTs: at(50) });
    await seed(userId, 'Waiting', { status: 'waitingFor', rank: 'a0', expectedBy: '2026-11-09', updatedTs: at(40) });
    // Snoozed: hidden from Next Actions in the app, listed in the tickler tier despite its early due date.
    await seed(userId, 'Snoozed', { status: 'nextAction', rank: 'Zz', expectedBy: '2026-11-01', ignoreBefore: snoozedUntil, updatedTs: at(30) });
    await seed(userId, 'Someday', { status: 'somedayMaybe', rank: 'a0', updatedTs: at(20) });
    await seed(userId, 'Done', { status: 'done', updatedTs: at(10) });
}

const PRIORITY_ORDER = ['Inbox', 'Next today', 'Next undated', 'Meeting', 'Waiting', 'Snoozed', 'Someday', 'Done'];

describe('GET /v1/items?sort=priority', () => {
    it('lists items in the app order: list by list, each in its own order', async () => {
        const caller = await newCaller();
        await seedEveryList(caller.userId);
        expect(await titlesOf(caller, 'sort=priority')).toEqual(PRIORITY_ORDER);
    });

    it('keeps updatedTs DESC as the default sort', async () => {
        const caller = await newCaller();
        await seedEveryList(caller.userId);
        expect(await titlesOf(caller, '')).toEqual([...PRIORITY_ORDER].reverse());
        expect(await titlesOf(caller, 'sort=updated')).toEqual([...PRIORITY_ORDER].reverse());
    });

    it('applies the status and text filters before ordering', async () => {
        const caller = await newCaller();
        await seedEveryList(caller.userId);
        expect(await titlesOf(caller, 'sort=priority&status=nextAction,inbox')).toEqual(['Inbox', 'Next today', 'Next undated', 'Snoozed']);
        expect(await titlesOf(caller, 'sort=priority&q=next')).toEqual(['Next today', 'Next undated']);
    });

    it('pages through the whole order with nextCursor, without gaps or repeats', async () => {
        const caller = await newCaller();
        await seedEveryList(caller.userId);
        const first = (await (await list(caller, 'sort=priority&limit=3')).json()) as ListResponse;
        if (!first.nextCursor) throw new Error('expected a next page');
        const second = (await (await list(caller, `sort=priority&limit=3&cursor=${first.nextCursor}`)).json()) as ListResponse;
        if (!second.nextCursor) throw new Error('expected a third page');
        const third = (await (await list(caller, `sort=priority&limit=3&cursor=${second.nextCursor}`)).json()) as ListResponse;
        expect([...first.items, ...second.items, ...third.items].map((row) => row.title)).toEqual(PRIORITY_ORDER);
        expect(third.nextCursor).toBeUndefined();
    });

    it('returns full documents for the page, not just the fields the order needs', async () => {
        const caller = await newCaller();
        await seedEveryList(caller.userId);
        const res = await list(caller, 'sort=priority&limit=1');
        const body = (await res.json()) as { items: Array<{ title: string; notes?: string; brief?: unknown }> };
        expect(body.items).toEqual([expect.objectContaining({ title: 'Inbox', notes: 'full row', brief: null })]);
    });

    it('applies since before ordering', async () => {
        const caller = await newCaller();
        await seedEveryList(caller.userId);
        const since = dayjs().subtract(35, 'minute').toISOString();
        expect(await titlesOf(caller, `sort=priority&since=${since}`)).toEqual(['Snoozed', 'Someday', 'Done']);
    });

    it('answers an empty last page for an offset at or past the end', async () => {
        const caller = await newCaller();
        await seedEveryList(caller.userId);
        const pastEnd = Buffer.from(JSON.stringify({ o: 50 })).toString('base64url');
        const body = (await (await list(caller, `sort=priority&cursor=${pastEnd}`)).json()) as ListResponse;
        expect(body).toEqual({ items: [] });
    });

    it('pages a briefState-filtered priority list: short pages keep a cursor, the walk yields the filtered set in order', async () => {
        const caller = await newCaller();
        await seedEveryList(caller.userId);
        const walk = async (cursor: string | undefined, seen: string[]): Promise<string[]> => {
            const page = (await (await list(caller, `sort=priority&briefState=none&limit=3${cursor ? `&cursor=${cursor}` : ''}`)).json()) as ListResponse;
            const titles = [...seen, ...page.items.map((row) => row.title)];
            return page.nextCursor ? walk(page.nextCursor, titles) : titles;
        };
        // No row has a brief, so `none` keeps them all — what matters is that paging under the post-filter loses nothing.
        expect(await walk(undefined, [])).toEqual(PRIORITY_ORDER);
    });

    it.each([{ o: -1 }, { o: 1.5 }, { o: '3' }, {}])('rejects the malformed priority cursor %j with 400 invalid_cursor', async (payload) => {
        const caller = await newCaller();
        const cursor = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const res = await list(caller, `sort=priority&cursor=${cursor}`);
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_cursor');
    });

    it('rejects an unknown sort with 400 invalid_sort', async () => {
        const caller = await newCaller();
        const res = await list(caller, 'sort=alphabetical');
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('invalid_sort');
    });

    it('rejects a cursor minted under the other sort with 400 invalid_cursor (a cursor is only meaningful in its own order)', async () => {
        const caller = await newCaller();
        await seedEveryList(caller.userId);
        const updatedPage = (await (await list(caller, 'limit=2')).json()) as ListResponse;
        const priorityPage = (await (await list(caller, 'sort=priority&limit=2')).json()) as ListResponse;
        for (const query of [`sort=priority&cursor=${updatedPage.nextCursor}`, `cursor=${priorityPage.nextCursor}`]) {
            const res = await list(caller, query);
            expect(res.status).toBe(400);
            expect(((await res.json()) as { code: string }).code).toBe('invalid_cursor');
        }
    });
});
