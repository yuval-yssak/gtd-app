import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import itemsDAO from '../dataAccess/itemsDAO.js';
import { dedupeCalendarItemsPerEvent } from '../loaders/calendarItemDuplicateMigration.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { ItemInterface } from '../types/entities.js';

const USER = 'user-item-dedup';
const INDEX_NAME = 'uniq_calendar_item_per_event';

beforeAll(async () => {
    await loadDataAccess('gtd_test_item_dedup');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await db.collection('items').deleteMany({});
    // The unique index is built by loadDataAccess; drop it so violating fixtures can be inserted
    // (exactly the boot precondition the migration exists to satisfy). Tests rebuild it to prove the
    // post-migration data is clean enough for the index to build.
    await db
        .collection('items')
        .dropIndex(INDEX_NAME)
        .catch(() => undefined);
});

function makeItem(overrides: Partial<ItemInterface> = {}): ItemInterface {
    const now = '2026-01-01T00:00:00.000Z';
    const item: ItemInterface = {
        _id: 'i-default',
        user: USER,
        status: 'calendar',
        title: 'Standup',
        timeStart: '2026-06-01T09:00:00Z',
        timeEnd: '2026-06-01T09:30:00Z',
        calendarEventId: 'event-1',
        calendarIntegrationId: 'int-1',
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
    // Real in-app / routine-instance items OMIT calendarEventId rather than storing null.
    if (overrides.calendarEventId === undefined && 'calendarEventId' in overrides) {
        delete item.calendarEventId;
    }
    return item;
}

describe('dedupeCalendarItemsPerEvent', () => {
    it('keeps the most-recently-updated live item and trashes the rest, leaving the index buildable', async () => {
        await itemsDAO.insertOne(makeItem({ _id: 'i-old', updatedTs: '2026-01-01T00:00:00.000Z' }));
        await itemsDAO.insertOne(makeItem({ _id: 'i-mid', updatedTs: '2026-02-01T00:00:00.000Z' }));
        await itemsDAO.insertOne(makeItem({ _id: 'i-new', updatedTs: '2026-03-01T00:00:00.000Z' }));

        await dedupeCalendarItemsPerEvent(db);

        expect((await itemsDAO.findByOwnerAndId('i-new', USER))?.status).toBe('calendar');
        expect((await itemsDAO.findByOwnerAndId('i-old', USER))?.status).toBe('trash');
        expect((await itemsDAO.findByOwnerAndId('i-mid', USER))?.status).toBe('trash');
        // Trashed losers got their updatedTs bumped so devices reconcile on next pull.
        expect((await itemsDAO.findByOwnerAndId('i-old', USER))?.updatedTs).not.toBe('2026-01-01T00:00:00.000Z');

        // Post-migration data is clean → the unique index now builds without throwing.
        await expect(itemsDAO.ensureUniqueCalendarEventIndex()).resolves.toBeUndefined();
        // And a second live item on the same event now throws E11000.
        await expect(itemsDAO.insertOne(makeItem({ _id: 'i-dup' }))).rejects.toMatchObject({ code: 11000 });
    });

    it('leaves a single live item untouched (no false trash)', async () => {
        await itemsDAO.insertOne(makeItem({ _id: 'i-solo' }));

        await dedupeCalendarItemsPerEvent(db);

        const solo = await itemsDAO.findByOwnerAndId('i-solo', USER);
        expect(solo?.status).toBe('calendar');
        expect(solo?.updatedTs).toBe('2026-01-01T00:00:00.000Z');
    });

    it('does not collapse items that differ by calendarEventId', async () => {
        await itemsDAO.insertOne(makeItem({ _id: 'i-a', calendarEventId: 'event-1' }));
        await itemsDAO.insertOne(makeItem({ _id: 'i-b', calendarEventId: 'event-2' }));

        await dedupeCalendarItemsPerEvent(db);

        expect((await itemsDAO.findByOwnerAndId('i-a', USER))?.status).toBe('calendar');
        expect((await itemsDAO.findByOwnerAndId('i-b', USER))?.status).toBe('calendar');
    });

    it('ignores trashed/done rows, in-app items, and routine-instance items', async () => {
        await itemsDAO.insertOne(makeItem({ _id: 'i-live' }));
        // A trashed twin keeps its calendarEventId (so it can be revived) but must not be regrouped.
        await itemsDAO.insertOne(makeItem({ _id: 'i-dead', status: 'trash' }));
        // In-app item: no calendarEventId.
        await itemsDAO.insertOne(makeItem({ _id: 'i-inapp', calendarEventId: undefined }));
        // Routine-instance item: carries calendarInstanceEventId, not calendarEventId.
        await itemsDAO.insertOne(makeItem({ _id: 'i-instance', calendarEventId: undefined, routineId: 'r-1', calendarInstanceEventId: 'inst-1' }));

        await dedupeCalendarItemsPerEvent(db);

        expect((await itemsDAO.findByOwnerAndId('i-live', USER))?.status).toBe('calendar');
        expect((await itemsDAO.findByOwnerAndId('i-dead', USER))?.status).toBe('trash');
        expect((await itemsDAO.findByOwnerAndId('i-inapp', USER))?.status).toBe('calendar');
        expect((await itemsDAO.findByOwnerAndId('i-instance', USER))?.status).toBe('calendar');
        // The live item + its trashed twin still share calendarEventId — the index (status:'calendar' only) still builds.
        await expect(itemsDAO.ensureUniqueCalendarEventIndex()).resolves.toBeUndefined();
    });

    it('is idempotent — a second run finds no groups and changes nothing', async () => {
        await itemsDAO.insertOne(makeItem({ _id: 'i-1', updatedTs: '2026-01-01T00:00:00.000Z' }));
        await itemsDAO.insertOne(makeItem({ _id: 'i-2', updatedTs: '2026-02-01T00:00:00.000Z' }));

        await dedupeCalendarItemsPerEvent(db);
        const afterFirst = await itemsDAO.findByOwnerAndId('i-1', USER);
        await dedupeCalendarItemsPerEvent(db);
        const afterSecond = await itemsDAO.findByOwnerAndId('i-1', USER);

        expect(afterFirst?.status).toBe('trash');
        expect(afterSecond?.updatedTs).toBe(afterFirst?.updatedTs);
        const live = await itemsDAO.findArray({ user: USER, calendarEventId: 'event-1', status: 'calendar' });
        expect(live).toHaveLength(1);
    });
});
