/**
 * `rank` carry-forward: the apply pipeline is a whole-document replace, so a device that edits a
 * row before pulling its rank (after the backfill, after another device's drag) would erase it.
 * `hydrateItemCarryForwards` keeps the stored rank on a rank-less incoming item snapshot for EVERY
 * status — unlike the calendar link, which detach statuses deliberately drop.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import { applyAndPublishOperation, applyAndPublishOperations } from '../lib/applyOperation.js';
import { carryForwardRank, RANK_CARRIED_FIELDS } from '../lib/rankCarryForward.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { ItemInterface } from '../types/entities.js';

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([db.collection('items').deleteMany({}), db.collection('operations').deleteMany({})]);
});

const userId = 'user-rank-carry';
const T0 = '2026-10-20T10:00:00.000Z';
const T1 = '2026-10-20T10:05:00.000Z';

const stored = (overrides: Partial<ItemInterface> = {}): ItemInterface => ({
    _id: 'item-rank-1',
    user: userId,
    status: 'nextAction',
    title: 'ranked task',
    rank: 'a0V',
    createdTs: T0,
    updatedTs: T0,
    ...overrides,
});

describe('carryForwardRank (pure)', () => {
    it('keeps the stored rank when the incoming snapshot lacks one', () => {
        const incoming = { ...stored(), title: 'edited', updatedTs: T1 };
        const { rank: _r, ...rankless } = incoming;
        expect(carryForwardRank(stored(), rankless)).toEqual(incoming);
    });

    it('keeps the incoming rank when the snapshot carries one (a drag on another device)', () => {
        const incoming = { ...stored(), rank: 'a0G', updatedTs: T1 };
        expect(carryForwardRank(stored(), incoming)).toBe(incoming);
    });

    it('returns the incoming snapshot untouched when neither side has a rank', () => {
        const { rank: _r, ...unranked } = stored();
        const incoming = { ...unranked, updatedTs: T1 };
        expect(carryForwardRank(unranked, incoming)).toBe(incoming);
    });

    it.each(['inbox', 'nextAction', 'calendar', 'waitingFor', 'somedayMaybe', 'done', 'trash'] as const)(
        'carries across a %s snapshot (status-independent)',
        (status) => {
            const { rank: _r, ...rankless } = stored();
            expect(carryForwardRank(stored(), { ...rankless, status, updatedTs: T1 }).rank).toBe('a0V');
        },
    );

    it('parity pin — the SAME literals live in client/src/tests/rankMerge.test.ts; change both together', () => {
        expect(RANK_CARRIED_FIELDS).toEqual(['rank']);
    });
});

describe('hydrateItemCarryForwards through the apply pipeline', () => {
    it('a newer rank-less update keeps the stored rank on the row AND in the recorded op', async () => {
        await itemsDAO.insertOne(stored());
        const { rank: _r, ...rankless } = stored();
        const op = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'update', entityId: 'item-rank-1', snapshot: { ...rankless, title: 'edited offline', updatedTs: T1 } },
            { deviceId: 'device-A' },
        );
        const row = await itemsDAO.findByOwnerAndId('item-rank-1', userId);
        expect(row?.title).toBe('edited offline');
        expect(row?.rank).toBe('a0V');
        expect((op.snapshot as ItemInterface).rank).toBe('a0V');
        const [logged] = await operationsDAO.findArray({ user: userId });
        expect((logged?.snapshot as ItemInterface | undefined)?.rank).toBe('a0V');
    });

    it('a detach-status (nextAction) snapshot still carries the rank even though the calendar link is not carried', async () => {
        await itemsDAO.insertOne(stored({ status: 'calendar', timeStart: '2026-10-21T09:00:00', timeEnd: '2026-10-21T10:00:00', calendarEventId: 'evt-1' }));
        const { rank: _r, ...rankless } = stored();
        await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'update', entityId: 'item-rank-1', snapshot: { ...rankless, status: 'nextAction', updatedTs: T1 } },
            { deviceId: 'device-A' },
        );
        const row = await itemsDAO.findByOwnerAndId('item-rank-1', userId);
        expect(row?.status).toBe('nextAction');
        expect(row?.rank).toBe('a0V');
        expect(row?.calendarEventId).toBeUndefined();
    });

    it('the batch path (/sync/push) carries it too', async () => {
        await itemsDAO.insertOne(stored());
        const { rank: _r, ...rankless } = stored();
        const { ops } = await applyAndPublishOperations(
            userId,
            [{ entityType: 'item', opType: 'update', entityId: 'item-rank-1', snapshot: { ...rankless, status: 'done', updatedTs: T1 } }],
            { deviceId: 'device-B' },
        );
        expect((ops[0]?.snapshot as ItemInterface | undefined)?.rank).toBe('a0V');
        expect((await itemsDAO.findByOwnerAndId('item-rank-1', userId))?.rank).toBe('a0V');
    });

    it('skipCalendarLinkCarryForward (the routine pause path) still carries the rank', async () => {
        await itemsDAO.insertOne(
            stored({
                status: 'calendar',
                timeStart: '2026-10-21T09:00:00',
                timeEnd: '2026-10-21T10:00:00',
                calendarInstanceEventId: 'master_20261021T090000Z',
            }),
        );
        const {
            rank: _r,
            calendarInstanceEventId: _c,
            ...rankless
        } = stored({ status: 'calendar', timeStart: '2026-10-21T09:00:00', timeEnd: '2026-10-21T10:00:00' });
        await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'update', entityId: 'item-rank-1', snapshot: { ...rankless, status: 'trash', updatedTs: T1 } },
            { deviceId: 'server', skipCalendarLinkCarryForward: true },
        );
        const row = await itemsDAO.findByOwnerAndId('item-rank-1', userId);
        expect(row?.rank).toBe('a0V');
        expect(row?.calendarInstanceEventId).toBeUndefined();
    });

    it('an incoming rank (another device reordered) wins over the stored one', async () => {
        await itemsDAO.insertOne(stored());
        await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'update', entityId: 'item-rank-1', snapshot: { ...stored(), rank: 'Zz', updatedTs: T1 } },
            { deviceId: 'device-A' },
        );
        expect((await itemsDAO.findByOwnerAndId('item-rank-1', userId))?.rank).toBe('Zz');
    });

    it('a brand-new row (no stored row) is left exactly as sent — no rank is minted by the pipeline', async () => {
        const { rank: _r, ...rankless } = stored();
        await applyAndPublishOperation(userId, { entityType: 'item', opType: 'create', entityId: 'item-rank-1', snapshot: rankless }, { deviceId: 'device-A' });
        expect((await itemsDAO.findByOwnerAndId('item-rank-1', userId))?.rank).toBeUndefined();
    });
});
