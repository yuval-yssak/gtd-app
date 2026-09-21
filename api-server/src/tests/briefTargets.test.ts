/** Sweep selection (lib/brief/briefTargets.ts): the pure rule and the per-user paged query. */
import dayjs from 'dayjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import itemBriefsDAO from '../dataAccess/itemBriefsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import { briefTargetPageQuery, findBriefTargets, isBriefTarget } from '../lib/brief/briefTargets.js';
import { briefSourceHash } from '../lib/briefSource.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { BriefOrigin, ItemBriefInterface, ItemInterface } from '../types/entities.js';

beforeAll(async () => {
    await loadDataAccess('gtd_test_brief_targets');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([db.collection('items').deleteMany({}), db.collection('itemBriefs').deleteMany({})]);
});

const ITEM = { title: 'Renew passport', notes: 'Expires in March; need photos and the old passport.' };

function brief(origin: BriefOrigin, sourceHash: string): ItemBriefInterface {
    const now = dayjs().toISOString();
    return { _id: 'x', user: 'u', itemId: 'x', text: origin === 'skipped' ? null : 'b', origin, sourceHash, generatedTs: now, createdTs: now, updatedTs: now };
}

describe('isBriefTarget', () => {
    const fresh = briefSourceHash(ITEM.title, ITEM.notes);

    it('is true with no row, and for a stale model or skipped row', () => {
        expect(isBriefTarget(ITEM, undefined)).toBe(true);
        expect(isBriefTarget(ITEM, null)).toBe(true);
        expect(isBriefTarget(ITEM, brief('model', 'stale'))).toBe(true);
        expect(isBriefTarget(ITEM, brief('skipped', 'stale'))).toBe(true);
    });

    it('is false for any fresh row and for a pinned row, stale or not', () => {
        expect(isBriefTarget(ITEM, brief('model', fresh))).toBe(false);
        expect(isBriefTarget(ITEM, brief('skipped', fresh))).toBe(false);
        expect(isBriefTarget(ITEM, brief('user', 'stale'))).toBe(false);
        expect(isBriefTarget(ITEM, brief('agent', 'stale'))).toBe(false);
        expect(isBriefTarget(ITEM, brief('user', fresh))).toBe(false);
    });
});

interface Seed {
    id: string;
    user?: string;
    status?: ItemInterface['status'];
    updatedTs: string;
    notes?: string;
    brief?: { origin: BriefOrigin; stale?: boolean; user?: string };
}

async function seed(rows: Seed[]): Promise<void> {
    const items: ItemInterface[] = rows.map((row) => ({
        _id: row.id,
        user: row.user ?? 'user-a',
        status: row.status ?? 'nextAction',
        title: `Item ${row.id}`,
        notes: row.notes ?? ITEM.notes,
        createdTs: row.updatedTs,
        updatedTs: row.updatedTs,
    }));
    await itemsDAO.insertMany(items);
    const briefs: ItemBriefInterface[] = rows.flatMap((row, index) => {
        const item = items[index];
        if (!row.brief || !item) return [];
        const hash = row.brief.stale ? 'stale-hash' : briefSourceHash(item.title, item.notes);
        return [{ ...brief(row.brief.origin, hash), _id: row.id, itemId: row.id, user: row.brief.user ?? item.user }];
    });
    if (briefs.length > 0) {
        await itemBriefsDAO.insertMany(briefs);
    }
}

const t = (minutesAgo: number) => dayjs('2026-09-20T12:00:00Z').subtract(minutesAgo, 'minute').toISOString();

describe('findBriefTargets', () => {
    it("returns every user's live items (newest-first per user) before any done/trash, pairing each with its stale row", async () => {
        await seed([
            { id: 'done-new', status: 'done', updatedTs: t(0) },
            { id: 'live-old', updatedTs: t(30), user: 'user-b' },
            { id: 'live-new', updatedTs: t(10), brief: { origin: 'model', stale: true } },
            { id: 'trash-old', status: 'trash', updatedTs: t(60) },
            { id: 'live-mid', status: 'inbox', updatedTs: t(20), brief: { origin: 'skipped', stale: true } },
        ]);
        const targets = await findBriefTargets(10);
        const ids = targets.map((target) => target.item._id);
        // Live pass (both users) strictly precedes the archive pass; within user-a, newest first.
        expect(ids.slice(0, 3).sort()).toEqual(['live-mid', 'live-new', 'live-old']);
        expect(ids.indexOf('live-new')).toBeLessThan(ids.indexOf('live-mid'));
        expect(ids.slice(3)).toEqual(['done-new', 'trash-old']);
        const byId = new Map(targets.map((target) => [target.item._id, target]));
        expect(byId.get('live-new')?.brief?.origin).toBe('model');
        expect(byId.get('live-mid')?.brief?.origin).toBe('skipped');
        expect(byId.get('live-old')?.brief).toBeUndefined();
    });

    it('excludes fresh rows and pinned rows (even stale), and treats a row owned by another user as absent', async () => {
        await seed([
            { id: 'fresh-model', updatedTs: t(1), brief: { origin: 'model' } },
            { id: 'fresh-skipped', updatedTs: t(2), brief: { origin: 'skipped' } },
            { id: 'pinned-stale', updatedTs: t(3), brief: { origin: 'user', stale: true } },
            { id: 'pinned-agent', updatedTs: t(4), brief: { origin: 'agent', stale: true } },
            { id: 'foreign-row', updatedTs: t(5), brief: { origin: 'model', user: 'someone-else' } },
        ]);
        const targets = await findBriefTargets(10);
        expect(targets.map((target) => target.item._id)).toEqual(['foreign-row']);
        expect(targets[0]?.brief).toBeUndefined();
    });

    it('still returns skip-eligible items (short notes) so the caller can record the skipped row', async () => {
        await seed([{ id: 'short', updatedTs: t(1), notes: 'tiny' }]);
        expect((await findBriefTargets(10)).map((target) => target.item._id)).toEqual(['short']);
    });

    it('honours the limit across the live → archive boundary and page boundaries', async () => {
        const rows: Seed[] = Array.from({ length: 1_203 }, (_, i) => ({
            id: `i-${String(i).padStart(4, '0')}`,
            status: i % 2 === 0 ? 'nextAction' : 'done',
            updatedTs: t(i),
            // Every third item already has a fresh row and must be skipped without counting.
            ...(i % 3 === 0 ? { brief: { origin: 'model' as const } } : {}),
        }));
        await seed(rows);
        const targets = await findBriefTargets(700);
        expect(targets).toHaveLength(700);
        const liveCount = targets.filter((target) => target.item.status === 'nextAction').length;
        // 602 live items minus the 1-in-3 fresh ones (~401) come first, then done fills the rest.
        expect(liveCount).toBe(rows.filter((row) => row.status === 'nextAction' && !row.brief).length);
        expect(targets.slice(0, liveCount).every((target) => target.item.status === 'nextAction')).toBe(true);
        expect(targets.every((target) => target.brief === undefined)).toBe(true);
    });

    it('a non-positive limit returns [] without touching the database', async () => {
        const spy = vi.spyOn(itemsDAO, 'distinctOwners');
        expect(await findBriefTargets(0)).toEqual([]);
        expect(await findBriefTargets(-1)).toEqual([]);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('the page query is a backward walk of { user, updatedTs } with NO in-memory SORT stage', async () => {
        await seed([
            { id: 'x', updatedTs: t(1) },
            { id: 'y', status: 'done', updatedTs: t(2) },
        ]);
        const { filter, sort, hint } = briefTargetPageQuery('user-a', ['inbox', 'nextAction']);
        const explained = (await db.collection('items').find(filter, { sort, hint }).explain('queryPlanner')) as {
            queryPlanner: { winningPlan: { stage: string } };
        };
        const { winningPlan } = explained.queryPlanner;
        expect(winningPlan.stage).not.toBe('SORT');
        const plan = JSON.stringify(winningPlan);
        expect(plan).not.toContain('"SORT"');
        expect(plan).not.toContain('COLLSCAN');
        expect(plan).toContain('user_1_updatedTs_1');
    });

    it('distinctOwners is served by the { user } index (DISTINCT_SCAN, no collection scan)', async () => {
        await seed([
            { id: 'x', updatedTs: t(1) },
            { id: 'y', updatedTs: t(2), user: 'user-b' },
        ]);
        expect((await itemsDAO.distinctOwners()).sort()).toEqual(['user-a', 'user-b']);
        const explained = (await db.command({ explain: { distinct: 'items', key: 'user' }, verbosity: 'queryPlanner' })) as {
            queryPlanner: { winningPlan: unknown };
        };
        const plan = JSON.stringify(explained.queryPlanner.winningPlan);
        expect(plan).toContain('DISTINCT_SCAN');
        expect(plan).not.toContain('COLLSCAN');
    });
});
