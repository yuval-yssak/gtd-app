/** Review-start sweep (lib/brief/briefSweepMine.ts) against Mongo with the model mocked: live
 * statuses only, checksum-mismatch selection, pinned exclusion, the 50-generation ceiling with
 * unbounded skip rows, strictly serial background execution, per-user cooldown, cap independence. */
import dayjs from 'dayjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import itemBriefsDAO from '../dataAccess/itemBriefsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import {
    __resetReviewSweepCooldownForTests,
    __settleReviewSweepsForTests,
    BRIEF_REVIEW_SWEEP_MAX,
    reviewSweepCooldownMs,
    startReviewBriefSweep,
} from '../lib/brief/briefSweepMine.js';
import { briefSourceHash } from '../lib/briefSource.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { BriefOrigin, ItemBriefInterface, ItemInterface, ItemStatus, OperationInterface } from '../types/entities.js';

const generateBriefText = vi.fn();
vi.mock('../lib/brief/briefModel.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/brief/briefModel.js')>()),
    generateBriefText: (...args: unknown[]) => generateBriefText(...args),
}));

const chargeBriefGeneration = vi.fn();
vi.mock('../lib/brief/briefCap.js', () => ({ chargeBriefGeneration: (...args: unknown[]) => chargeBriefGeneration(...args) }));

beforeAll(async () => {
    await loadDataAccess('gtd_test_brief_sweep_mine');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([db.collection('items').deleteMany({}), db.collection('itemBriefs').deleteMany({}), db.collection('operations').deleteMany({})]);
    __resetReviewSweepCooldownForTests();
    generateBriefText.mockReset().mockImplementation(async (item: { title: string }) => ({ text: `brief for ${item.title}`, model: 'mock' }));
    chargeBriefGeneration.mockReset();
});

afterEach(async () => {
    await __settleReviewSweepsForTests();
    vi.unstubAllEnvs();
});

// ─── Seeds ──────────────────────────────────────────────────────────────────

const USER = 'user-a';
const LONG_NOTES =
    'Expires in March; need photos and the old passport. The consulate only takes appointments on weekday mornings, ' +
    'and the earliest slot is usually three weeks out, so the photos have to be done before booking.';

interface Seed {
    id: string;
    user?: string;
    status?: ItemStatus;
    notes?: string;
    brief?: { origin: BriefOrigin; stale: boolean };
}

async function seed(rows: Seed[]): Promise<void> {
    const now = dayjs().toISOString();
    const items: ItemInterface[] = rows.map((row) => ({
        _id: row.id,
        user: row.user ?? USER,
        status: row.status ?? 'nextAction',
        title: `Item ${row.id}`,
        notes: row.notes ?? LONG_NOTES,
        createdTs: now,
        updatedTs: now,
    }));
    await itemsDAO.insertMany(items);
    const briefs: ItemBriefInterface[] = rows.flatMap((row, index) => {
        const item = items[index];
        if (!row.brief || !item) return [];
        const sourceHash = row.brief.stale ? 'stale-hash' : briefSourceHash(item.title, item.notes);
        const text = row.brief.origin === 'skipped' ? null : 'old';
        return [{ _id: row.id, user: item.user, itemId: row.id, text, origin: row.brief.origin, sourceHash, generatedTs: now, createdTs: now, updatedTs: now }];
    });
    if (briefs.length > 0) {
        await itemBriefsDAO.insertMany(briefs);
    }
}

function generatedTitles(): string[] {
    return generateBriefText.mock.calls.map(([item]) => (item as { title: string }).title).sort();
}

// ─── Selection ──────────────────────────────────────────────────────────────

describe('startReviewBriefSweep — selection', () => {
    it('targets only the caller’s LIVE items whose checksum mismatches (or that have no row); pinned, fresh, archived and other users are excluded', async () => {
        await seed([
            { id: 'no-row' },
            { id: 'stale-model', brief: { origin: 'model', stale: true } },
            { id: 'stale-skipped', brief: { origin: 'skipped', stale: true } },
            { id: 'fresh-model', brief: { origin: 'model', stale: false } },
            { id: 'stale-user', brief: { origin: 'user', stale: true } },
            { id: 'stale-agent', brief: { origin: 'agent', stale: true } },
            { id: 'done-no-row', status: 'done' },
            { id: 'trash-no-row', status: 'trash' },
            { id: 'inbox-no-row', status: 'inbox' },
            { id: 'calendar-no-row', status: 'calendar' },
            { id: 'waiting-no-row', status: 'waitingFor' },
            { id: 'someday-no-row', status: 'somedayMaybe' },
            { id: 'other-user', user: 'user-b' },
        ]);

        const result = await startReviewBriefSweep(USER);
        await __settleReviewSweepsForTests();

        expect(result).toEqual({ started: 7, skippedWritten: 0, cooldown: false });
        expect(generatedTitles()).toEqual(
            ['no-row', 'stale-model', 'stale-skipped', 'inbox-no-row', 'calendar-no-row', 'waiting-no-row', 'someday-no-row'].map((id) => `Item ${id}`).sort(),
        );
        expect(await itemBriefsDAO.findByOwnerAndId('stale-user', USER)).toMatchObject({ origin: 'user', text: 'old' });
        expect(await itemBriefsDAO.findByOwnerAndId('done-no-row', USER)).toBeNull();
        expect(await itemBriefsDAO.findByOwnerAndId('other-user', 'user-b')).toBeNull();
        expect(await itemBriefsDAO.findByOwnerAndId('no-row', USER)).toMatchObject({ origin: 'model', text: 'brief for Item no-row' });
    });

    it('writes skip rows synchronously (unbounded) and stamps every write with the sweep device id', async () => {
        await seed([
            { id: 'short-1', notes: 'short' },
            { id: 'short-2', notes: 'short' },
            { id: 'short-stale', notes: 'short', brief: { origin: 'skipped', stale: true } },
            { id: 'long-1' },
        ]);

        const result = await startReviewBriefSweep(USER);
        // Skip rows are already there BEFORE the background run settles.
        expect(result).toEqual({ started: 1, skippedWritten: 3, cooldown: false });
        for (const id of ['short-1', 'short-2', 'short-stale']) {
            expect(await itemBriefsDAO.findByOwnerAndId(id, USER)).toMatchObject({ origin: 'skipped', sourceHash: briefSourceHash(`Item ${id}`, 'short') });
        }
        await __settleReviewSweepsForTests();
        const ops = await db.collection<OperationInterface>('operations').find({ user: USER }).toArray();
        expect(ops).toHaveLength(4);
        expect(new Set(ops.map((op) => op.deviceId))).toEqual(new Set(['server:brief-sweep-mine']));
    });

    it('returns { started: 0, skippedWritten: 0 } (not cooldown) when nothing needs a brief', async () => {
        await seed([{ id: 'fresh', brief: { origin: 'model', stale: false } }]);
        await expect(startReviewBriefSweep(USER)).resolves.toEqual({ started: 0, skippedWritten: 0, cooldown: false });
        expect(generateBriefText).not.toHaveBeenCalled();
    });
});

// ─── Bounds + execution ─────────────────────────────────────────────────────

describe('startReviewBriefSweep — bounds and execution', () => {
    it(`generates at most ${BRIEF_REVIEW_SWEEP_MAX} briefs while still writing every skip row`, async () => {
        const longs: Seed[] = Array.from({ length: BRIEF_REVIEW_SWEEP_MAX + 10 }, (_, i) => ({ id: `long-${i}` }));
        const shorts: Seed[] = Array.from({ length: 5 }, (_, i) => ({ id: `short-${i}`, notes: 'short' }));
        await seed([...longs, ...shorts]);

        const result = await startReviewBriefSweep(USER);
        await __settleReviewSweepsForTests();

        expect(result).toEqual({ started: BRIEF_REVIEW_SWEEP_MAX, skippedWritten: 5, cooldown: false });
        expect(generateBriefText).toHaveBeenCalledTimes(BRIEF_REVIEW_SWEEP_MAX);
        expect(await itemBriefsDAO.countDocuments({ user: USER, origin: 'model' })).toBe(BRIEF_REVIEW_SWEEP_MAX);
        expect(await itemBriefsDAO.countDocuments({ user: USER, origin: 'skipped' })).toBe(5);
    });

    it('runs the model calls strictly one at a time, in the background', async () => {
        const overlap: number[] = [];
        // A counter is the only way to observe concurrency from inside the mock; scoped to this test.
        let inFlight = 0;
        generateBriefText.mockImplementation(async (item: { title: string }) => {
            inFlight += 1;
            overlap.push(inFlight);
            await new Promise((resolve) => setImmediate(resolve));
            inFlight -= 1;
            return { text: `brief for ${item.title}`, model: 'mock' };
        });
        await seed(Array.from({ length: 6 }, (_, i) => ({ id: `long-${i}` })));

        const result = await startReviewBriefSweep(USER);
        expect(result.started).toBe(6);
        // Returned before the generations finished.
        expect(generateBriefText.mock.calls.length).toBeLessThan(6);
        await __settleReviewSweepsForTests();

        expect(generateBriefText).toHaveBeenCalledTimes(6);
        expect(Math.max(...overlap)).toBe(1);
    });

    it('logs a failed generation and carries on with the rest', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        generateBriefText.mockImplementation(async (item: { title: string }) => {
            if (item.title === 'Item long-1') throw new Error('overloaded');
            return { text: `brief for ${item.title}`, model: 'mock' };
        });
        await seed([{ id: 'long-0' }, { id: 'long-1' }, { id: 'long-2' }]);

        await startReviewBriefSweep(USER);
        await __settleReviewSweepsForTests();

        expect(generateBriefText).toHaveBeenCalledTimes(3);
        expect(await itemBriefsDAO.findByOwnerAndId('long-1', USER)).toBeNull();
        expect(await itemBriefsDAO.findByOwnerAndId('long-2', USER)).toMatchObject({ origin: 'model' });
        expect(error).toHaveBeenCalledWith(expect.stringContaining('long-1'));
    });

    it('never charges the on-demand per-user cap', async () => {
        await seed([{ id: 'long-0' }, { id: 'long-1' }]);
        await startReviewBriefSweep(USER);
        await __settleReviewSweepsForTests();
        expect(generateBriefText).toHaveBeenCalledTimes(2);
        expect(chargeBriefGeneration).not.toHaveBeenCalled();
    });
});

// ─── Cooldown ───────────────────────────────────────────────────────────────

describe('startReviewBriefSweep — cooldown', () => {
    it('refuses a second sweep for the same user inside the cooldown, per user', async () => {
        await seed([{ id: 'a-long' }, { id: 'b-long', user: 'user-b' }]);

        await expect(startReviewBriefSweep(USER)).resolves.toMatchObject({ started: 1, cooldown: false });
        await expect(startReviewBriefSweep(USER)).resolves.toEqual({ started: 0, cooldown: true });
        await expect(startReviewBriefSweep('user-b')).resolves.toMatchObject({ started: 1, cooldown: false });
        await __settleReviewSweepsForTests();
        expect(generateBriefText).toHaveBeenCalledTimes(2);
    });

    it('stamps the cooldown before doing any work, so a double-fire collapses to one sweep', async () => {
        await seed([{ id: 'a-long' }]);
        const [first, second] = await Promise.all([startReviewBriefSweep(USER), startReviewBriefSweep(USER)]);
        expect([first.cooldown, second.cooldown].sort()).toEqual([false, true]);
        await __settleReviewSweepsForTests();
        expect(generateBriefText).toHaveBeenCalledTimes(1);
    });

    it('honours BRIEF_REVIEW_SWEEP_COOLDOWN_MS (0 disables it) and falls back to 10 minutes for garbage', async () => {
        expect(reviewSweepCooldownMs()).toBe(10 * 60 * 1000);
        vi.stubEnv('BRIEF_REVIEW_SWEEP_COOLDOWN_MS', 'soon');
        expect(reviewSweepCooldownMs()).toBe(10 * 60 * 1000);
        // An EMPTY string is what the deploy writes for an unset GitHub variable — it must NOT read as 0.
        vi.stubEnv('BRIEF_REVIEW_SWEEP_COOLDOWN_MS', '');
        expect(reviewSweepCooldownMs()).toBe(10 * 60 * 1000);
        vi.stubEnv('BRIEF_REVIEW_SWEEP_COOLDOWN_MS', '   ');
        expect(reviewSweepCooldownMs()).toBe(10 * 60 * 1000);
        vi.stubEnv('BRIEF_REVIEW_SWEEP_COOLDOWN_MS', '-5');
        expect(reviewSweepCooldownMs()).toBe(10 * 60 * 1000);
        vi.stubEnv('BRIEF_REVIEW_SWEEP_COOLDOWN_MS', '0');
        expect(reviewSweepCooldownMs()).toBe(0);
        await seed([{ id: 'a-long' }]);
        await expect(startReviewBriefSweep(USER)).resolves.toMatchObject({ cooldown: false });
        await __settleReviewSweepsForTests();
        await expect(startReviewBriefSweep(USER)).resolves.toMatchObject({ cooldown: false });
    });
});
