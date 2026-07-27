/**
 * Coverage for the manual remediation script that retires a routine stranded active on a cancelled GCal
 * series (`scripts/retireOrphanedSeriesSuccessor.ts`).
 *
 * The properties under test are the ones that make the script safe to point at a REAL shared work
 * calendar: it must trash only FUTURE items (past occurrences are real history), it must CAP the rrule
 * rather than merely pause (so `newlyLosesUntil` can still revive it and `healSplitSuccessorRoutines`
 * won't ping-pong), it must release `calendarInstanceEventId` so the freed id vacates the
 * presence-partial unique index, it must record ops so other devices converge, and `--dry-run` (the
 * default) must write NOTHING.
 *
 * The CLI entry point is not exercised — `retireStrandedSuccessor` is invoked directly so the test owns
 * the DB connection.
 */
import dayjs from 'dayjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { cappedRrule, phantomItemsFilter, retireStrandedSuccessor } from '../scripts/retireOrphanedSeriesSuccessor.js';
import type { ItemInterface, RoutineInterface } from '../types/entities.js';

const USER = 'user-retire-successor';
const OTHER_USER = 'user-retire-successor-other';
const ROUTINE_ID = 'routine-stranded-successor';
const MASTER = 'gcal-master-cancelled-1';
const NOW = '2026-07-27T10:00:00.000Z';

beforeAll(async () => {
    await loadDataAccess('gtd_test_retire_orphaned_successor');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([db.collection('items').deleteMany({}), db.collection('routines').deleteMany({}), db.collection('operations').deleteMany({})]);
});

function makeRoutine(overrides: Partial<RoutineInterface> = {}): RoutineInterface {
    return {
        _id: ROUTINE_ID,
        user: USER,
        title: 'Daily - Engineering',
        routineType: 'calendar',
        rrule: 'FREQ=WEEKLY;WKST=SU;BYDAY=MO,TU,WE,TH,SU',
        template: {},
        active: true,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
        calendarItemTemplate: { timeOfDay: '09:45', duration: 15 },
        calendarEventId: MASTER,
        ...overrides,
    };
}

function makeItem(id: string, timeStart: string, overrides: Partial<ItemInterface> = {}): ItemInterface {
    return {
        _id: id,
        user: USER,
        title: 'Daily - Engineering',
        status: 'calendar',
        routineId: ROUTINE_ID,
        timeStart,
        timeEnd: dayjs(timeStart).add(15, 'minute').toISOString(),
        // Per-occurrence ids: the `uniq_calendar_item_per_event` index forbids two live items sharing a
        // `calendarEventId` for one user, which is exactly how real routine-generated occurrences look.
        calendarEventId: `${MASTER}_${id}`,
        calendarInstanceEventId: `${MASTER}_${id}`,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

const applyOpts = { userId: USER, routineId: ROUTINE_ID, apply: true };
const dryRunOpts = { userId: USER, routineId: ROUTINE_ID, apply: false };

describe('phantomItemsFilter', () => {
    it('selects items at or after now, and excludes the moment before', () => {
        const filter = phantomItemsFilter(makeRoutine(), NOW);
        expect(filter).toEqual({ user: USER, routineId: ROUTINE_ID, status: 'calendar', timeStart: { $gte: NOW } });
    });
});

describe('cappedRrule', () => {
    it('caps the rrule at the day before `now`, stripping any pre-existing UNTIL', () => {
        expect(cappedRrule(makeRoutine(), NOW)).toBe('FREQ=WEEKLY;WKST=SU;BYDAY=MO,TU,WE,TH,SU;UNTIL=20260726T235959Z');
    });

    it('does not stack a second UNTIL when re-run against an already-capped rrule', () => {
        const alreadyCapped = makeRoutine({ rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260726T235959Z' });
        expect(cappedRrule(alreadyCapped, NOW)).toBe('FREQ=WEEKLY;BYDAY=MO;UNTIL=20260726T235959Z');
    });
});

describe('retireStrandedSuccessor', () => {
    it('retires the routine and trashes only future items, preserving the past', async () => {
        await routinesDAO.insertOne(makeRoutine());
        await itemsDAO.insertMany([
            makeItem('item-past', '2026-07-26T09:45:00.000Z'),
            makeItem('item-future-1', '2026-07-28T09:45:00.000Z'),
            makeItem('item-future-2', '2026-08-03T09:45:00.000Z'),
        ]);

        await retireStrandedSuccessor(applyOpts, NOW);

        const routine = await routinesDAO.findByOwnerAndId(ROUTINE_ID, USER);
        expect(routine?.active).toBe(false);
        expect(routine?.rrule).toContain('UNTIL=20260726T235959Z');
        // Marked so the /maintenance heals ("Repair sync") skip this row instead of resurrecting it.
        expect(routine?.retiredByGCal).toBe(true);

        const past = await itemsDAO.findOne({ _id: 'item-past' });
        expect(past?.status).toBe('calendar');
        expect(past?.calendarInstanceEventId).toBe(`${MASTER}_item-past`);

        const future = await itemsDAO.findArray({ _id: { $in: ['item-future-1', 'item-future-2'] } });
        expect(future.map((i) => i.status)).toEqual(['trash', 'trash']);
        for (const item of future) {
            expect(item.calendarInstanceEventId).toBeUndefined();
        }
    });

    it('stamps updatedTs to now on both the routine and the trashed items', async () => {
        await routinesDAO.insertOne(makeRoutine());
        await itemsDAO.insertOne(makeItem('item-future-1', '2026-07-28T09:45:00.000Z'));

        await retireStrandedSuccessor(applyOpts, NOW);

        // Without a fresh `updatedTs` the row replicates carrying its ORIGINAL timestamp, loses
        // last-write-wins to any concurrent device edit, and silently un-retires itself.
        const routine = await routinesDAO.findByOwnerAndId(ROUTINE_ID, USER);
        expect(routine?.updatedTs).toBe(NOW);
        const item = await itemsDAO.findOne({ _id: 'item-future-1' });
        expect(item?.updatedTs).toBe(NOW);
    });

    it('records ops carrying the POST-write snapshot so other devices converge', async () => {
        await routinesDAO.insertOne(makeRoutine());
        await itemsDAO.insertOne(makeItem('item-future-1', '2026-07-28T09:45:00.000Z'));

        await retireStrandedSuccessor(applyOpts, NOW);

        const routineOps = await operationsDAO.findArray({ entityType: 'routine', entityId: ROUTINE_ID });
        expect(routineOps).toHaveLength(1);
        const [routineOp] = routineOps;
        if (!routineOp) throw new Error('expected one routine op');
        expect(routineOp.snapshot).toMatchObject({ active: false, retiredByGCal: true });
        expect((routineOp.snapshot as RoutineInterface).rrule).toContain('UNTIL=');

        const itemOps = await operationsDAO.findArray({ entityType: 'item', entityId: 'item-future-1' });
        expect(itemOps).toHaveLength(1);
        const [itemOp] = itemOps;
        if (!itemOp) throw new Error('expected one item op');
        // The snapshot must reflect the state AFTER the write — a pre-write snapshot would replicate
        // `status:'calendar'` back onto every device and resurrect the phantom.
        expect(itemOp.snapshot).toMatchObject({ status: 'trash' });
        expect((itemOp.snapshot as ItemInterface).calendarInstanceEventId).toBeUndefined();
    });

    it('writes nothing on a dry run', async () => {
        await routinesDAO.insertOne(makeRoutine());
        await itemsDAO.insertOne(makeItem('item-future-1', '2026-07-28T09:45:00.000Z'));

        await retireStrandedSuccessor(dryRunOpts, NOW);

        const routine = await routinesDAO.findByOwnerAndId(ROUTINE_ID, USER);
        expect(routine?.active).toBe(true);
        expect(routine?.rrule).not.toContain('UNTIL=');
        const item = await itemsDAO.findOne({ _id: 'item-future-1' });
        expect(item?.status).toBe('calendar');
        expect(await operationsDAO.countDocuments({})).toBe(0);
    });

    it('is idempotent — a second run neither re-writes the routine nor double-caps the rrule', async () => {
        await routinesDAO.insertOne(makeRoutine());
        await itemsDAO.insertOne(makeItem('item-future-1', '2026-07-28T09:45:00.000Z'));

        await retireStrandedSuccessor(applyOpts, NOW);
        const afterFirst = await routinesDAO.findByOwnerAndId(ROUTINE_ID, USER);
        await db.collection('operations').deleteMany({});

        await retireStrandedSuccessor(applyOpts, '2026-07-27T11:00:00.000Z');

        const afterSecond = await routinesDAO.findByOwnerAndId(ROUTINE_ID, USER);
        // Second run: already inactive AND already marked → stampRetirementMarker short-circuits,
        // so no second routine op and no re-cap.
        expect(afterSecond?.rrule).toBe(afterFirst?.rrule);
        expect(afterSecond?.updatedTs).toBe(afterFirst?.updatedTs);
        expect(await operationsDAO.countDocuments({ entityType: 'routine' })).toBe(0);
    });

    it('backfills retiredByGCal on an already-inactive routine retired before the marker existed', async () => {
        // The pre-marker state: this script's own earlier runs (and deactivateRoutineFromGCal before the
        // marker shipped) left the routine capped + inactive but unmarked — still resurrectable by heals.
        await routinesDAO.insertOne(makeRoutine({ active: false, rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260726T235959Z' }));

        await retireStrandedSuccessor(applyOpts, NOW);

        const routine = await routinesDAO.findByOwnerAndId(ROUTINE_ID, USER);
        expect(routine?.retiredByGCal).toBe(true);
        expect(routine?.active).toBe(false);
        // The stamp must replicate: it carries a fresh updatedTs and records an op, or other devices
        // (and the server the heals read from) never learn the row is protected.
        expect(routine?.updatedTs).toBe(NOW);
        const ops = await operationsDAO.findArray({ entityType: 'routine', entityId: ROUTINE_ID });
        expect(ops).toHaveLength(1);
        const [op] = ops;
        if (!op) throw new Error('expected one backfill op');
        expect(op.snapshot).toMatchObject({ retiredByGCal: true, active: false });

        // Second run: already marked → no further routine write or op.
        await db.collection('operations').deleteMany({});
        await retireStrandedSuccessor(applyOpts, '2026-07-27T11:00:00.000Z');
        expect(await operationsDAO.countDocuments({ entityType: 'routine' })).toBe(0);
        expect((await routinesDAO.findByOwnerAndId(ROUTINE_ID, USER))?.updatedTs).toBe(NOW);
    });

    it('refuses a routine belonging to a different user', async () => {
        await routinesDAO.insertOne(makeRoutine({ user: OTHER_USER }));

        await expect(retireStrandedSuccessor(applyOpts, NOW)).rejects.toThrow(/not found for user/);

        const routine = await routinesDAO.findByOwnerAndId(ROUTINE_ID, OTHER_USER);
        expect(routine?.active).toBe(true);
    });

    it('refuses a routine with no calendarEventId — not a GCal-linked series routine', async () => {
        const { calendarEventId: _drop, ...unlinked } = makeRoutine();
        await routinesDAO.insertOne(unlinked as RoutineInterface);

        await expect(retireStrandedSuccessor(applyOpts, NOW)).rejects.toThrow(/no calendarEventId/);
    });

    it('leaves another routine on the same series untouched', async () => {
        await routinesDAO.insertOne(makeRoutine());
        await routinesDAO.insertOne(makeRoutine({ _id: 'routine-live-sibling', calendarEventId: 'gcal-master-live-2' }));
        await itemsDAO.insertOne(makeItem('item-sibling', '2026-07-28T10:15:00.000Z', { routineId: 'routine-live-sibling' }));

        await retireStrandedSuccessor(applyOpts, NOW);

        const sibling = await routinesDAO.findByOwnerAndId('routine-live-sibling', USER);
        expect(sibling?.active).toBe(true);
        expect(sibling?.rrule).not.toContain('UNTIL=');
        const siblingItem = await itemsDAO.findOne({ _id: 'item-sibling' });
        expect(siblingItem?.status).toBe('calendar');
    });
});
