/**
 * The `items.briefStale` marker (lib/brief/briefStaleMarker.ts + the ItemsDAO overrides that stamp
 * it, lib/brief/briefStaleBackfill.ts that repairs a pre-marker corpus).
 *
 * The marker is what makes the brief sweep a bounded indexed lookup instead of a full walk, so the
 * thing worth proving here is that EVERY write path maintains it. Item writes are spread over ~40
 * call sites, which is exactly why the marker lives in the DAO: the pure-rule tests below pin the
 * decision, and the "write path" describe block drives the real production entry points.
 */
import dayjs from 'dayjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import itemsDAO from '../dataAccess/itemsDAO.js';
import { backfillBriefStaleMarkers } from '../lib/brief/briefStaleBackfill.js';
import {
    markBriefStaleOnBulkOperation,
    markBriefStaleOnDocument,
    stripBriefStale,
    updateTouchesBriefSource,
    withBriefStaleMark,
} from '../lib/brief/briefStaleMarker.js';
import { propagateRoutineNotesToItems } from '../lib/calendarItemNotes.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { ItemInterface } from '../types/entities.js';

beforeAll(async () => {
    await loadDataAccess('gtd_test_brief_stale_marker');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([db.collection('items').deleteMany({}), db.collection('operations').deleteMany({})]);
});

const USER = 'user-a';

function item(overrides: Partial<ItemInterface> = {}): ItemInterface & { _id: string } {
    const now = dayjs().toISOString();
    return {
        _id: 'item-1',
        user: USER,
        status: 'nextAction',
        title: 'Renew passport',
        notes: 'Long enough notes.',
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
}

/** Reads the marker straight off the collection, bypassing the DAO that maintains it. */
async function markerOf(itemId: string): Promise<boolean | undefined> {
    const row = await db.collection<ItemInterface>('items').findOne({ _id: itemId } as never);
    return row?.briefStale;
}

/** Seeds an already-settled row (no marker) — the state a swept item is left in. */
async function seedSettled(overrides: Partial<ItemInterface> = {}): Promise<ItemInterface & { _id: string }> {
    const seeded = item(overrides);
    await db.collection<ItemInterface>('items').insertOne(seeded as never);
    return seeded;
}

describe('the pure marking rules', () => {
    it('strips a caller-supplied marker before re-stamping, so a client cannot assert "fresh"', () => {
        expect(stripBriefStale({ title: 't', briefStale: false })).toEqual({ title: 't' });
        expect(markBriefStaleOnDocument({ title: 't', briefStale: false })).toEqual({ title: 't', briefStale: true });
    });

    it('marks an update that can move the title, the notes or the status', () => {
        expect(updateTouchesBriefSource({ $set: { title: 'new' } })).toBe(true);
        expect(updateTouchesBriefSource({ $set: { notes: 'new' } })).toBe(true);
        expect(updateTouchesBriefSource({ $unset: { notes: '' } })).toBe(true);
        expect(updateTouchesBriefSource({ $set: { status: 'done' } })).toBe(true);
        expect(updateTouchesBriefSource({ $rename: { title: 'other' } })).toBe(true);
        expect(updateTouchesBriefSource({ $setOnInsert: { title: 't' } })).toBe(true);
    });

    it('leaves an update that cannot move it completely untouched, object identity included', () => {
        const update = { $set: { calendarEventId: 'evt', updatedTs: 'now' }, $unset: { lastKnownCalendarEventId: '' as const } };
        expect(updateTouchesBriefSource(update)).toBe(false);
        // Same reference: the common case must not allocate or read differently in a log.
        expect(withBriefStaleMark(update)).toBe(update);
    });

    it('merges the mark into an existing $set rather than replacing it', () => {
        expect(withBriefStaleMark({ $set: { notes: 'n', updatedTs: 'now' } })).toEqual({ $set: { notes: 'n', updatedTs: 'now', briefStale: true } });
    });

    it('marks every shape of bulk operation that can carry content', () => {
        expect(markBriefStaleOnBulkOperation({ insertOne: { document: item() } })).toMatchObject({ insertOne: { document: { briefStale: true } } });
        expect(markBriefStaleOnBulkOperation({ replaceOne: { filter: {}, replacement: item() } })).toMatchObject({
            replaceOne: { replacement: { briefStale: true } },
        });
        expect(markBriefStaleOnBulkOperation({ updateOne: { filter: {}, update: { $set: { title: 't' } } } })).toMatchObject({
            updateOne: { update: { $set: { briefStale: true } } },
        });
        // A bulk update that cannot move the source is passed through unchanged.
        expect(markBriefStaleOnBulkOperation({ updateMany: { filter: {}, update: { $set: { urgent: true } } } })).toMatchObject({
            updateMany: { update: { $set: { urgent: true } } },
        });
    });
});

describe('every DAO write path maintains the marker', () => {
    it('insertOne marks a new item', async () => {
        await itemsDAO.insertOne(item());
        expect(await markerOf('item-1')).toBe(true);
    });

    it('insertMany marks every new item', async () => {
        await itemsDAO.insertMany([item({ _id: 'a' }), item({ _id: 'b' })]);
        expect(await markerOf('a')).toBe(true);
        expect(await markerOf('b')).toBe(true);
    });

    it('replaceById marks — this is the choke point behind /sync/push and every /v1 write', async () => {
        const seeded = await seedSettled();
        expect(await markerOf(seeded._id)).toBeUndefined();
        await itemsDAO.replaceById(seeded._id, { ...seeded, notes: 'Edited notes, long enough to matter.' });
        expect(await markerOf(seeded._id)).toBe(true);
    });

    it('replaceById marks even when the caller carries a stale `briefStale: false` in the snapshot', async () => {
        const seeded = await seedSettled();
        await itemsDAO.replaceById(seeded._id, { ...seeded, briefStale: false, notes: 'Edited.' });
        expect(await markerOf(seeded._id)).toBe(true);
    });

    it('replaceByOwner marks — the cross-account reassign primitive', async () => {
        const seeded = await seedSettled();
        await itemsDAO.replaceByOwner(seeded._id, USER, { ...seeded, user: 'user-b' });
        expect(await markerOf(seeded._id)).toBe(true);
    });

    it('updateOne marks a notes edit but not an unrelated field write', async () => {
        const seeded = await seedSettled();
        await itemsDAO.updateOne({ _id: seeded._id }, { $set: { calendarEventId: 'evt' } });
        expect(await markerOf(seeded._id)).toBeUndefined();
        await itemsDAO.updateOne({ _id: seeded._id }, { $set: { notes: 'Now edited.' } });
        expect(await markerOf(seeded._id)).toBe(true);
    });

    it('updateOne marks a title edit — the reference-cascade breadcrumb path', async () => {
        const seeded = await seedSettled();
        await itemsDAO.updateOne({ _id: seeded._id }, { $set: { title: 'Renew passport [person removed: Dana]' } });
        expect(await markerOf(seeded._id)).toBe(true);
    });

    it('updateOne marks a notes CLEAR, not just a notes set', async () => {
        const seeded = await seedSettled();
        await itemsDAO.updateOne({ _id: seeded._id }, { $unset: { notes: '' } });
        expect(await markerOf(seeded._id)).toBe(true);
    });

    it('updateOne marks a status change, so a revived item becomes targetable again', async () => {
        const seeded = await seedSettled({ status: 'trash' });
        await itemsDAO.updateOne({ _id: seeded._id }, { $set: { status: 'nextAction' } });
        expect(await markerOf(seeded._id)).toBe(true);
    });

    it('updateMany marks every matched item — the GCal trash/propagation sweeps', async () => {
        await db.collection<ItemInterface>('items').insertMany([item({ _id: 'a' }), item({ _id: 'b' })] as never);
        await itemsDAO.updateMany({ user: USER }, { $set: { status: 'trash' } });
        expect(await markerOf('a')).toBe(true);
        expect(await markerOf('b')).toBe(true);
    });

    it('bulkWrite marks its own operations — the DAO overrides cannot see inside them', async () => {
        await seedSettled({ _id: 'bulk-1' });
        await itemsDAO.bulkWrite([
            { updateOne: { filter: { _id: 'bulk-1' } as never, update: { $set: { notes: 'Imported notes.' } } } },
            { insertOne: { document: item({ _id: 'bulk-2' }) } },
        ]);
        expect(await markerOf('bulk-1')).toBe(true);
        expect(await markerOf('bulk-2')).toBe(true);
    });

    it('propagateRoutineNotesToItems marks — the one notes-only production write path', async () => {
        await seedSettled({ _id: 'routine-item', status: 'calendar', routineId: 'r1', timeStart: dayjs().toISOString() });
        await propagateRoutineNotesToItems('r1', 'Notes pushed down from the routine.', USER);
        expect(await markerOf('routine-item')).toBe(true);
    });
});

describe('the settle guard', () => {
    it('settles an item against its own content, whether its notes are absent or empty', async () => {
        await itemsDAO.insertMany([item({ _id: 'absent', notes: undefined }), item({ _id: 'empty', notes: '' })]);
        await itemsDAO.clearBriefStale('absent', USER, { title: 'Renew passport', notes: undefined, status: 'nextAction' });
        await itemsDAO.clearBriefStale('empty', USER, { title: 'Renew passport', notes: '', status: 'nextAction' });
        expect(await markerOf('absent')).toBe(false);
        expect(await markerOf('empty')).toBe(false);
    });

    it('refuses to settle when the content does not match — absent and empty notes are distinct', async () => {
        // `notes: undefined` becomes `notes: null` in the filter so it matches ONLY a missing field.
        // Were it dropped instead, the guard would match any notes at all and settle the wrong item.
        await itemsDAO.insertMany([item({ _id: 'absent', notes: undefined }), item({ _id: 'empty', notes: '' })]);
        await itemsDAO.clearBriefStale('absent', USER, { title: 'Renew passport', notes: '', status: 'nextAction' });
        await itemsDAO.clearBriefStale('empty', USER, { title: 'Renew passport', notes: undefined, status: 'nextAction' });
        expect(await markerOf('absent')).toBe(true);
        expect(await markerOf('empty')).toBe(true);
    });

    it('refuses to settle when the title or status moved', async () => {
        await itemsDAO.insertOne(item({ _id: 'moved' }));
        await itemsDAO.clearBriefStale('moved', USER, { title: 'A different title', notes: 'Long enough notes.', status: 'nextAction' });
        expect(await markerOf('moved')).toBe(true);
        await itemsDAO.clearBriefStale('moved', USER, { title: 'Renew passport', notes: 'Long enough notes.', status: 'inbox' });
        expect(await markerOf('moved')).toBe(true);
    });
});

describe('backfillBriefStaleMarkers', () => {
    it('marks a pre-marker corpus and reports how many it repaired', async () => {
        await db.collection<ItemInterface>('items').insertMany([item({ _id: 'old-1' }), item({ _id: 'old-2', status: 'done' })] as never);
        expect(await backfillBriefStaleMarkers()).toBe(2);
        expect(await markerOf('old-1')).toBe(true);
        expect(await markerOf('old-2')).toBe(true);
    });

    it('is idempotent — a second run marks nothing', async () => {
        await db.collection<ItemInterface>('items').insertOne(item({ _id: 'old-1' }) as never);
        expect(await backfillBriefStaleMarkers()).toBe(1);
        expect(await backfillBriefStaleMarkers()).toBe(0);
    });

    it('converges from a PARTIALLY backfilled corpus — the restart case', async () => {
        // The shape a crashed/interrupted run leaves behind: some rows marked, the rest untouched.
        await db
            .collection<ItemInterface>('items')
            .insertMany([{ ...item({ _id: 'already-marked' }), briefStale: true }, item({ _id: 'unmarked-1' }), item({ _id: 'unmarked-2' })] as never);
        expect(await backfillBriefStaleMarkers()).toBe(2);
        for (const id of ['already-marked', 'unmarked-1', 'unmarked-2']) {
            expect(await markerOf(id)).toBe(true);
        }
        expect(await backfillBriefStaleMarkers()).toBe(0);
    });

    it('leaves a settled item settled while still claiming its never-seen neighbours', async () => {
        await db.collection<ItemInterface>('items').insertMany([{ ...item({ _id: 'settled' }), briefStale: false }, item({ _id: 'never-seen' })] as never);
        expect(await backfillBriefStaleMarkers()).toBe(1);
        expect(await markerOf('settled')).toBe(false);
        expect(await markerOf('never-seen')).toBe(true);
    });

    it('is CONVERGENT, not just idempotent: it never re-marks an item the sweep already settled', async () => {
        // The production case, and the reason settling writes `false` instead of `$unset`: Cloud Run
        // scales to zero, so this runs on every cold start — several times a day. A filter that also
        // matched the settled state would re-mark the whole corpus each boot and undo the fix.
        const seeded = item({ _id: 'swept' });
        await db.collection<ItemInterface>('items').insertOne(seeded as never);
        expect(await backfillBriefStaleMarkers()).toBe(1);

        await itemsDAO.clearBriefStale('swept', USER, { title: seeded.title, notes: seeded.notes, status: seeded.status });
        expect(await markerOf('swept')).toBe(false);

        // Stands in for the next dozen cold starts: still nothing to do, still settled.
        for (const _boot of [1, 2, 3]) {
            expect(await backfillBriefStaleMarkers()).toBe(0);
        }
        expect(await markerOf('swept')).toBe(false);
        expect(await itemsDAO.countBriefStale(USER)).toBe(0);
    });

    it('leaves an empty collection alone', async () => {
        expect(await backfillBriefStaleMarkers()).toBe(0);
    });
});
