/** Seeded-DB coverage for `scripts/backfillItemRanks.ts` — see the script header for the rules. */
import dayjs from 'dayjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { applyAndPublishOperation } from '../lib/applyOperation.js';
import { compareRank, isStrictlyIncreasing } from '../lib/itemRank.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { BACKFILL_DEVICE_ID, type BackfillOptions, backfillUserItemRanks, compareLegacyOrder, stampedExpectedBy } from '../scripts/backfillItemRanks.js';
import type { ItemInterface, RoutineInterface } from '../types/entities.js';

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([db.collection('items').deleteMany({}), db.collection('routines').deleteMany({}), db.collection('operations').deleteMany({})]);
});

const USER = 'user-backfill-ranks';
const NOW = dayjs('2026-10-23T12:00:00.000Z');
const TODAY_UTC = '2026-10-23';
const OPTS: BackfillOptions = { dryRun: false, timezone: 'UTC', force: false };

type LegacyItem = ItemInterface & { focus?: boolean };

function seed(id: string, overrides: Partial<LegacyItem> = {}): LegacyItem {
    return { _id: id, user: USER, status: 'nextAction', title: id, createdTs: '2026-10-01T00:00:00.000Z', updatedTs: '2026-10-01T00:00:00.000Z', ...overrides };
}

async function rows(): Promise<Map<string, LegacyItem>> {
    const all = (await itemsDAO.findArray({ user: USER })) as LegacyItem[];
    return new Map(all.map((row) => [row._id ?? '', row]));
}

describe('stampedExpectedBy (D1)', () => {
    it('stamps today on a focused undated nextAction row', () => {
        expect(stampedExpectedBy(seed('a', { focus: true }), TODAY_UTC)).toBe(TODAY_UTC);
    });

    it('uses the later tickler date so the row surfaces as Today on its wake day', () => {
        expect(stampedExpectedBy(seed('a', { focus: true, ignoreBefore: '2026-11-05' }), TODAY_UTC)).toBe('2026-11-05');
        expect(stampedExpectedBy(seed('a', { focus: true, ignoreBefore: '2026-10-01' }), TODAY_UTC)).toBe(TODAY_UTC);
    });

    it('leaves dated and unfocused rows alone', () => {
        expect(stampedExpectedBy(seed('a', { focus: true, expectedBy: '2026-12-01' }), TODAY_UTC)).toBeNull();
        expect(stampedExpectedBy(seed('a', {}), TODAY_UTC)).toBeNull();
    });
});

describe('compareLegacyOrder', () => {
    it('focus first, dated before undated, date asc, then newest first, then _id', () => {
        const ordered = [
            seed('focusDated', { focus: true, expectedBy: '2026-10-30' }),
            seed('focusUndated', { focus: true }),
            seed('plainEarly', { expectedBy: '2026-10-25' }),
            seed('plainLate', { expectedBy: '2026-11-25' }),
            seed('plainNewer', { createdTs: '2026-10-20T00:00:00.000Z' }),
            seed('plainOlderA', { createdTs: '2026-10-10T00:00:00.000Z' }),
            seed('plainOlderB', { createdTs: '2026-10-10T00:00:00.000Z' }),
        ];
        const shuffled = [...ordered].reverse().sort(compareLegacyOrder);
        expect(shuffled.map((row) => row._id)).toEqual(ordered.map((row) => row._id));
    });

    it('with existing ranks, rank order beats createdTs inside a tier and unranked rows lead (force re-key keeps a manual order)', () => {
        const a = seed('a', { rank: 'a1', createdTs: '2026-10-20T00:00:00.000Z' });
        const b = seed('b', { rank: 'a0', createdTs: '2026-10-10T00:00:00.000Z' });
        const fresh = seed('fresh', { createdTs: '2026-09-01T00:00:00.000Z' });
        expect([a, b, fresh].sort(compareLegacyOrder).map((row) => row._id)).toEqual(['fresh', 'b', 'a']);
    });
});

describe('backfillUserItemRanks', () => {
    it('ranks nextAction rows in the legacy order, stamps focused undated rows today, unsets focus, keeps rank-only updatedTs', async () => {
        await itemsDAO.insertMany([
            seed('focusUndated', { focus: true, createdTs: '2026-10-05T00:00:00.000Z' }),
            seed('focusTodayOlder', { focus: true, expectedBy: TODAY_UTC, createdTs: '2026-10-02T00:00:00.000Z' }),
            seed('plainToday', { expectedBy: TODAY_UTC }),
            seed('plainTomorrow', { expectedBy: '2026-10-24' }),
            seed('plainUndatedNew', { createdTs: '2026-10-15T00:00:00.000Z' }),
            seed('plainUndatedOld', { createdTs: '2026-10-03T00:00:00.000Z' }),
            seed('snoozedFocus', { focus: true, ignoreBefore: '2026-11-02' }),
        ]);
        const summary = await backfillUserItemRanks(USER, OPTS, NOW);
        expect(summary).toMatchObject({ nextActionRows: 7, stampedToday: 2, ranked: 7, skippedAlreadyRanked: false });

        const byId = await rows();
        const ordered = ['focusUndated', 'focusTodayOlder', 'snoozedFocus', 'plainToday', 'plainTomorrow', 'plainUndatedNew', 'plainUndatedOld'];
        const ranks = ordered.map((id) => byId.get(id)?.rank ?? '');
        expect(ranks.every(Boolean)).toBe(true);
        expect(isStrictlyIncreasing(ranks)).toBe(true);
        // The focused undated row is now dated today and sits ahead of the plain today row.
        expect(byId.get('focusUndated')?.expectedBy).toBe(TODAY_UTC);
        expect(compareRank(byId.get('focusUndated')?.rank ?? '', byId.get('plainToday')?.rank ?? '')).toBe(-1);
        // A focused row already dated today interleaves with it by createdTs (older after newer).
        expect(compareRank(byId.get('focusUndated')?.rank ?? '', byId.get('focusTodayOlder')?.rank ?? '')).toBe(-1);
        // Tickler-hidden focused row wakes as "Today" on its wake day.
        expect(byId.get('snoozedFocus')?.expectedBy).toBe('2026-11-02');
        for (const row of byId.values()) {
            expect(row).not.toHaveProperty('focus');
        }
        // Stamped rows bump updatedTs (content changed); rank-only rows keep theirs.
        expect(byId.get('focusUndated')?.updatedTs).toBe(NOW.toISOString());
        expect(byId.get('plainToday')?.updatedTs).toBe('2026-10-01T00:00:00.000Z');

        const ops = await operationsDAO.findArray({ user: USER });
        expect(ops).toHaveLength(7);
        expect(ops.every((op) => op.deviceId === BACKFILL_DEVICE_ID && op.opType === 'update')).toBe(true);
        const plainTodayOp = ops.find((op) => op.entityId === 'plainToday');
        expect((plainTodayOp?.snapshot as ItemInterface | undefined)?.updatedTs).toBe('2026-10-01T00:00:00.000Z');
        expect(plainTodayOp?.snapshot).not.toHaveProperty('focus');
        expect((plainTodayOp?.snapshot as ItemInterface | undefined)?.rank).toBe(byId.get('plainToday')?.rank);
    });

    it('an undated row gets NO expectedBy key (never null — the strict op schema would reject every later push)', async () => {
        await itemsDAO.insertMany([seed('undated', {}), seed('dated', { expectedBy: '2026-11-01' })]);
        await backfillUserItemRanks(USER, OPTS, NOW);
        const byId = await rows();
        expect(byId.get('undated')).not.toHaveProperty('expectedBy');
        expect(byId.get('dated')?.expectedBy).toBe('2026-11-01');
        const ops = await operationsDAO.findArray({ user: USER });
        expect(ops.find((op) => op.entityId === 'undated')?.snapshot).not.toHaveProperty('expectedBy');
    });

    it('a row edited or completed between planning and writing keeps its own state and gets no op (guarded write, no backdating)', async () => {
        await itemsDAO.insertMany([seed('edited', { updatedTs: '2026-10-01T00:00:00.000Z' }), seed('completed', {}), seed('plain', {})]);
        // Plan against the seeded rows, then let two rows move on before the write lands.
        const original = itemsDAO.findArray.bind(itemsDAO);
        const spy = vi.spyOn(itemsDAO, 'findArray').mockImplementationOnce(async (...args) => {
            const planned = await original(...args);
            await itemsDAO.updateOne(
                { _id: 'edited', user: USER } as never,
                { $set: { title: 'edited meanwhile', updatedTs: '2026-10-22T00:00:00.000Z' } } as never,
            );
            await itemsDAO.updateOne({ _id: 'completed', user: USER } as never, { $set: { status: 'done', updatedTs: '2026-10-22T00:00:00.000Z' } } as never);
            return planned;
        });
        await backfillUserItemRanks(USER, OPTS, NOW);
        spy.mockRestore();
        const byId = await rows();
        expect(byId.get('edited')).toMatchObject({ title: 'edited meanwhile', updatedTs: '2026-10-22T00:00:00.000Z' });
        expect(byId.get('edited')?.rank).toBeUndefined();
        expect(byId.get('completed')).toMatchObject({ status: 'done' });
        expect(byId.get('completed')?.rank).toBeUndefined();
        expect(byId.get('plain')?.rank).toBeDefined();
        const ops = await operationsDAO.findArray({ user: USER });
        expect(ops.map((op) => op.entityId)).toEqual(['plain']);
    });

    it('an already-ranked user still gets the closed-row / routine focus cleanup', async () => {
        await itemsDAO.insertMany([seed('ranked', { rank: 'a0' }), seed('doneFocus', { status: 'done', focus: true })]);
        const summary = await backfillUserItemRanks(USER, OPTS, NOW);
        expect(summary.skippedAlreadyRanked).toBe(true);
        expect(summary.focusUnsetElsewhere).toBe(1);
        expect((await rows()).get('doneFocus')).not.toHaveProperty('focus');
    });

    it('focused done/trash rows lose focus with no date, no rank and no op; routine templates lose focus too', async () => {
        await itemsDAO.insertMany([seed('doneFocus', { status: 'done', focus: true }), seed('trashFocus', { status: 'trash', focus: true }), seed('open', {})]);
        const routine: RoutineInterface = {
            _id: 'r-1',
            user: USER,
            title: 'r',
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY',
            template: { energy: 'low', focus: true } as RoutineInterface['template'],
            active: true,
            createdTs: '2026-10-01T00:00:00.000Z',
            updatedTs: '2026-10-01T00:00:00.000Z',
        };
        await routinesDAO.insertOne(routine);
        const summary = await backfillUserItemRanks(USER, OPTS, NOW);
        expect(summary.focusUnsetElsewhere).toBe(3);
        const byId = await rows();
        for (const id of ['doneFocus', 'trashFocus']) {
            const row = byId.get(id);
            expect(row).not.toHaveProperty('focus');
            expect(row?.expectedBy).toBeUndefined();
            expect(row?.rank).toBeUndefined();
        }
        expect((await routinesDAO.findByOwnerAndId('r-1', USER))?.template).toEqual({ energy: 'low' });
        const ops = await operationsDAO.findArray({ user: USER });
        expect(ops.map((op) => op.entityId)).toEqual(['open']);
    });

    it('after the backfill, a pushed snapshot whose updatedTs predates it still applies (tie → incoming) and keeps the rank', async () => {
        await itemsDAO.insertMany([seed('plain', { updatedTs: '2026-10-01T00:00:00.000Z' })]);
        await backfillUserItemRanks(USER, OPTS, NOW);
        const rank = (await rows()).get('plain')?.rank;
        expect(rank).toBeTruthy();
        // A device's older unpushed edit (same updatedTs as the row, which the backfill did not bump).
        const { rank: _r, ...rankless } = seed('plain', { title: 'edited before the backfill', updatedTs: '2026-10-01T00:00:00.000Z' });
        await applyAndPublishOperation(USER, { entityType: 'item', opType: 'update', entityId: 'plain', snapshot: rankless }, { deviceId: 'device-A' });
        const after = (await rows()).get('plain');
        expect(after?.title).toBe('edited before the backfill');
        expect(after?.rank).toBe(rank);
    });

    it('a rerun is a no-op without --force, and --force re-keys preserving the existing order', async () => {
        await itemsDAO.insertMany([seed('a', { createdTs: '2026-10-20T00:00:00.000Z' }), seed('b', { createdTs: '2026-10-10T00:00:00.000Z' })]);
        await backfillUserItemRanks(USER, OPTS, NOW);
        const first = await rows();
        const rerun = await backfillUserItemRanks(USER, OPTS, NOW);
        expect(rerun.skippedAlreadyRanked).toBe(true);
        expect(await operationsDAO.countDocuments({ user: USER })).toBe(2);
        // Simulate a manual reorder (b above a), then force: the manual order must survive.
        await itemsDAO.updateOne({ _id: 'b', user: USER } as never, { $set: { rank: 'Zz' } } as never);
        const forced = await backfillUserItemRanks(USER, { ...OPTS, force: true }, NOW);
        expect(forced.skippedAlreadyRanked).toBe(false);
        const after = await rows();
        expect(compareRank(after.get('b')?.rank ?? '', after.get('a')?.rank ?? '')).toBe(-1);
        expect(after.get('a')?.rank).not.toBe(first.get('a')?.rank);
    });

    it('dry run writes nothing', async () => {
        await itemsDAO.insertMany([seed('focusUndated', { focus: true }), seed('doneFocus', { status: 'done', focus: true })]);
        const summary = await backfillUserItemRanks(USER, { ...OPTS, dryRun: true }, NOW);
        expect(summary).toMatchObject({ stampedToday: 1, ranked: 1, focusUnsetElsewhere: 1 });
        const byId = await rows();
        expect(byId.get('focusUndated')?.rank).toBeUndefined();
        expect(byId.get('focusUndated')?.focus).toBe(true);
        expect(byId.get('doneFocus')?.focus).toBe(true);
        expect(await operationsDAO.countDocuments({ user: USER })).toBe(0);
    });

    it('a user with no nextAction rows is handled (nothing ranked, closed focus still unset)', async () => {
        await itemsDAO.insertMany([seed('doneFocus', { status: 'done', focus: true })]);
        const summary = await backfillUserItemRanks(USER, OPTS, NOW);
        expect(summary).toMatchObject({ nextActionRows: 0, ranked: 0, focusUnsetElsewhere: 1, skippedAlreadyRanked: false });
    });
});
