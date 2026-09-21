/** Sweep selection (lib/brief/briefTargets.ts): the pure rule and the marker-bounded page query. */
import dayjs from 'dayjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import itemBriefsDAO from '../dataAccess/itemBriefsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import { isBriefableStatus, LIVE_STATUSES } from '../lib/brief/briefScope.js';
import { briefTargetPageQuery, findBriefTargets, findUserBriefTargets, isBriefTarget } from '../lib/brief/briefTargets.js';
import { briefSourceHash } from '../lib/briefSource.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { BriefOrigin, ItemBriefInterface, ItemInterface, ItemStatus } from '../types/entities.js';

beforeAll(async () => {
    await loadDataAccess('gtd_test_brief_targets');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([db.collection('items').deleteMany({}), db.collection('itemBriefs').deleteMany({})]);
});

const ITEM = { title: 'Renew passport', notes: 'Expires in March; need photos and the old passport.', status: 'nextAction' as const };

function brief(origin: BriefOrigin, sourceHash: string): ItemBriefInterface {
    const now = dayjs().toISOString();
    return { _id: 'x', user: 'u', itemId: 'x', text: origin === 'skipped' ? null : 'b', origin, sourceHash, generatedTs: now, createdTs: now, updatedTs: now };
}

describe('isBriefableStatus', () => {
    it('covers the open statuses and excludes the closed ones', () => {
        expect(LIVE_STATUSES).toEqual(['inbox', 'nextAction', 'calendar', 'waitingFor', 'somedayMaybe']);
        for (const status of LIVE_STATUSES) {
            expect(isBriefableStatus(status)).toBe(true);
        }
        expect(isBriefableStatus('done')).toBe(false);
        expect(isBriefableStatus('trash')).toBe(false);
    });
});

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

    it('is false for a closed item however stale — a done/trash item is never reviewed', () => {
        for (const status of ['done', 'trash'] as const) {
            expect(isBriefTarget({ ...ITEM, status }, undefined)).toBe(false);
            expect(isBriefTarget({ ...ITEM, status }, brief('model', 'stale'))).toBe(false);
        }
    });
});

interface Seed {
    id: string;
    user?: string;
    status?: ItemStatus;
    updatedTs: string;
    notes?: string;
    /** Omitted ⇒ marked stale, the state every DAO write leaves behind. */
    briefStale?: false;
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
        ...(row.briefStale === false ? {} : { briefStale: true as const }),
    }));
    // Raw insert, NOT itemsDAO — the DAO would stamp `briefStale: true` on every row and these
    // fixtures need to express "already settled" too.
    await db.collection<ItemInterface>('items').insertMany(items);
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

/** The ids still carrying the marker, so a test can assert what the sweep settled. */
async function markedIds(): Promise<string[]> {
    const rows = await db.collection<ItemInterface>('items').find({ briefStale: true }).project({ _id: 1 }).toArray();
    return rows.map((row) => String(row._id)).sort();
}

describe('findBriefTargets', () => {
    it("returns every user's marked live items, pairing each with the stale row it would replace", async () => {
        await seed([
            { id: 'done-new', status: 'done', updatedTs: t(0) },
            { id: 'live-old', updatedTs: t(30), user: 'user-b' },
            { id: 'live-new', updatedTs: t(10), brief: { origin: 'model', stale: true } },
            { id: 'trash-old', status: 'trash', updatedTs: t(60) },
            { id: 'live-mid', status: 'inbox', updatedTs: t(20), brief: { origin: 'skipped', stale: true } },
        ]);
        const targets = await findBriefTargets(10);
        // Closed items are out of scope entirely — not deprioritised, absent.
        expect(targets.map((target) => target.item._id).sort()).toEqual(['live-mid', 'live-new', 'live-old']);
        const byId = new Map(targets.map((target) => [target.item._id, target]));
        expect(byId.get('live-new')?.brief?.origin).toBe('model');
        expect(byId.get('live-mid')?.brief?.origin).toBe('skipped');
        expect(byId.get('live-old')?.brief).toBeUndefined();
    });

    it('never targets a done or trash item, even when it is marked stale and has no brief', async () => {
        await seed([
            { id: 'done-1', status: 'done', updatedTs: t(1) },
            { id: 'trash-1', status: 'trash', updatedTs: t(2) },
            { id: 'done-2', status: 'done', updatedTs: t(3), brief: { origin: 'model', stale: true } },
        ]);
        expect(await findBriefTargets(10)).toEqual([]);
    });

    it('keeps an existing brief on a closed item — selection stops, nothing is deleted', async () => {
        await seed([{ id: 'done-briefed', status: 'done', updatedTs: t(1), brief: { origin: 'model' } }]);
        await findBriefTargets(10);
        expect(await itemBriefsDAO.findByOwnerAndId('done-briefed', 'user-a')).not.toBeNull();
    });

    it('re-targets an item revived from trash to a live status', async () => {
        await seed([{ id: 'revived', status: 'trash', updatedTs: t(5), briefStale: false }]);
        expect(await findBriefTargets(10)).toEqual([]);
        // A status-only edit through the DAO re-marks it — that is what makes a revive targetable.
        await itemsDAO.updateOne({ _id: 'revived' }, { $set: { status: 'nextAction', updatedTs: t(1) } });
        expect((await findBriefTargets(10)).map((target) => target.item._id)).toEqual(['revived']);
    });

    it('ignores items with no marker — an unmarked item is by definition settled', async () => {
        await seed([{ id: 'settled', updatedTs: t(1), briefStale: false }]);
        expect(await findBriefTargets(10)).toEqual([]);
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

    it('clears the marker on every examined item it does NOT target, so the set drains', async () => {
        await seed([
            { id: 'fresh-model', updatedTs: t(1), brief: { origin: 'model' } },
            { id: 'pinned-stale', updatedTs: t(2), brief: { origin: 'user', stale: true } },
            { id: 'real-target', updatedTs: t(3) },
        ]);
        await findBriefTargets(10);
        // Only the genuine target stays marked; it is cleared by the writer once its row lands.
        expect(await markedIds()).toEqual(['real-target']);
    });

    it('does NOT settle an item a concurrent write re-marked between the read and the clear', async () => {
        // The stranding race: the sweep reads a page, round-trips to `itemBriefs` and hashes in
        // Node before settling. A /sync/push flush or GCal webhook landing in that window marks the
        // item; an unguarded clear would erase that mark, leaving current content with a stale
        // brief and NOTHING to bring it back. The settle is guarded on the CONTENT it judged.
        await seed([{ id: 'edited-mid-sweep', updatedTs: t(1), brief: { origin: 'model' } }]);
        const realLoad = itemBriefsDAO.findArray.bind(itemBriefsDAO);
        const spy = vi.spyOn(itemBriefsDAO, 'findArray').mockImplementation(async (...args) => {
            const rows = await realLoad(...args);
            // The concurrent edit, inside the sweep's own read→settle window.
            await itemsDAO.updateOne({ _id: 'edited-mid-sweep' }, { $set: { notes: 'Rewritten while the sweep was thinking.', updatedTs: t(0) } });
            return rows;
        });
        await findBriefTargets(10);
        spy.mockRestore();
        // Still marked: the next sweep picks up the new content instead of losing it forever.
        expect(await markedIds()).toEqual(['edited-mid-sweep']);
    });

    it('settles an item that nothing touched during the sweep', async () => {
        await seed([{ id: 'untouched', updatedTs: t(1), brief: { origin: 'model' } }]);
        await findBriefTargets(10);
        expect(await markedIds()).toEqual([]);
    });

    it('still returns skip-eligible items (short notes) so the caller can record the skipped row', async () => {
        await seed([{ id: 'short', updatedTs: t(1), notes: 'tiny' }]);
        expect((await findBriefTargets(10)).map((target) => target.item._id)).toEqual(['short']);
    });

    it('honours the limit across page boundaries', async () => {
        const rows: Seed[] = Array.from({ length: 1_203 }, (_, i) => ({
            id: `i-${String(i).padStart(4, '0')}`,
            status: i % 2 === 0 ? ('nextAction' as const) : ('done' as const),
            updatedTs: t(i),
            // Every third item already has a fresh row and must be skipped without counting.
            ...(i % 3 === 0 ? { brief: { origin: 'model' as const } } : {}),
        }));
        await seed(rows);
        const liveTargets = rows.filter((row) => row.status === 'nextAction' && !row.brief).length;
        expect(await findBriefTargets(700)).toHaveLength(Math.min(700, liveTargets));
        expect((await findBriefTargets(10)).every((target) => target.item.status === 'nextAction')).toBe(true);
    });

    it('a non-positive limit returns [] without touching the database', async () => {
        const spy = vi.spyOn(itemsDAO, 'distinctOwners');
        expect(await findBriefTargets(0)).toEqual([]);
        expect(await findBriefTargets(-1)).toEqual([]);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });
});

describe('the selection query plan', () => {
    it('rides the partial { user, briefStale, status } index with no COLLSCAN and no blocking SORT', async () => {
        await seed([
            { id: 'x', updatedTs: t(1) },
            { id: 'y', status: 'done', updatedTs: t(2) },
        ]);
        const { filter, hint } = briefTargetPageQuery('user-a');
        const explained = (await db.collection('items').find(filter, { hint }).explain('queryPlanner')) as {
            queryPlanner: { winningPlan: { stage: string } };
        };
        const { winningPlan } = explained.queryPlanner;
        expect(winningPlan.stage).not.toBe('SORT');
        const plan = JSON.stringify(winningPlan);
        expect(plan).not.toContain('"SORT"');
        expect(plan).not.toContain('COLLSCAN');
        expect(plan).toContain('brief_stale_targets');
        // The status bound is part of the INDEX bounds, not a fetched residual: closed items are
        // never read off disk at all.
        expect(plan).toContain('"status"');
    });

    it('examines only the MARKED items, not the whole corpus — the bound that makes the sweep fast', async () => {
        const rows: Seed[] = Array.from({ length: 2_000 }, (_, i) => ({
            id: `p-${String(i).padStart(4, '0')}`,
            status: i < 1_800 ? ('done' as const) : ('nextAction' as const),
            updatedTs: t(i),
            // Only 5 items are left marked; everything else is settled.
            ...(i < 1_995 ? { briefStale: false as const } : {}),
        }));
        await seed(rows);
        const { filter, hint } = briefTargetPageQuery('user-a');
        const explained = (await db.collection('items').find(filter, { hint }).explain('executionStats')) as {
            executionStats: { totalDocsExamined: number; totalKeysExamined: number; nReturned: number };
        };
        const { totalDocsExamined, totalKeysExamined, nReturned } = explained.executionStats;
        expect(nReturned).toBe(5);
        // O(marked), not O(corpus): 5 keys and 5 documents out of 2 000 rows.
        expect(totalKeysExamined).toBe(5);
        expect(totalDocsExamined).toBe(5);
    });

    it('examines NOTHING in the steady state, where no item is marked', async () => {
        const rows: Seed[] = Array.from({ length: 500 }, (_, i) => ({ id: `s-${i}`, updatedTs: t(i), briefStale: false as const }));
        await seed(rows);
        const { filter, hint } = briefTargetPageQuery('user-a');
        const explained = (await db.collection('items').find(filter, { hint }).explain('executionStats')) as {
            executionStats: { totalDocsExamined: number; totalKeysExamined: number };
        };
        expect(explained.executionStats.totalKeysExamined).toBe(0);
        expect(explained.executionStats.totalDocsExamined).toBe(0);
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

describe('findUserBriefTargets', () => {
    it('is scoped to its user and finishes its page so false positives are cleared', async () => {
        await seed([
            { id: 'mine', updatedTs: t(1) },
            { id: 'mine-fresh', updatedTs: t(2), brief: { origin: 'model' } },
            { id: 'theirs', updatedTs: t(3), user: 'user-b' },
        ]);
        expect((await findUserBriefTargets('user-a', 10)).map((target) => target.item._id)).toEqual(['mine']);
        // user-b's item is untouched; user-a's already-fresh item is settled.
        expect(await markedIds()).toEqual(['mine', 'theirs']);
    });
});
