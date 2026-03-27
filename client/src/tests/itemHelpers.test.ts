import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getActiveNextActions, getItemsByStatus, getOverdueItems, getUpcomingCalendarItems } from '../db/itemHelpers';
import type { MyDB, StoredItem } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const USER_ID = 'user-1';

// Use absolute far-past / far-future dates so tests pass on any real clock date.
// vi.useFakeTimers() is intentionally avoided here: fake-indexeddb uses setTimeout
// internally for async ops and hangs indefinitely when timers are mocked.
const FAR_PAST = '2000-01-01';
const FAR_FUTURE = '2099-12-31';

function baseItem(id: string, overrides: Partial<StoredItem> = {}): StoredItem {
    return {
        _id: id,
        userId: USER_ID,
        status: 'inbox',
        title: `Item ${id}`,
        createdTs: '2025-01-01T00:00:00.000Z',
        updatedTs: '2025-01-01T00:00:00.000Z',
        ...overrides,
    };
}

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    db = await openTestDB();
});

afterEach(() => {
    db.close();
});

async function seed(items: StoredItem[]) {
    for (const item of items) {
        await db.put('items', item);
    }
}

// ── getItemsByStatus ───────────────────────────────────────────────────────────

describe('getItemsByStatus', () => {
    it('returns only items matching the given status', async () => {
        await seed([
            baseItem('i1', { status: 'inbox' }),
            baseItem('i2', { status: 'nextAction' }),
            baseItem('i3', { status: 'inbox' }),
            baseItem('i4', { status: 'done' }),
        ]);

        const inbox = await getItemsByStatus(db, USER_ID, 'inbox');
        expect(inbox).toHaveLength(2);
        expect(inbox.every((i) => i.status === 'inbox')).toBe(true);

        const done = await getItemsByStatus(db, USER_ID, 'done');
        expect(done).toHaveLength(1);
    });

    it('returns an empty array when no items match', async () => {
        await seed([baseItem('i5', { status: 'inbox' })]);
        const result = await getItemsByStatus(db, USER_ID, 'trash');
        expect(result).toHaveLength(0);
    });
});

// ── getActiveNextActions ───────────────────────────────────────────────────────

describe('getActiveNextActions', () => {
    it('returns nextAction items with no ignoreBefore set', async () => {
        await seed([baseItem('na1', { status: 'nextAction' }), baseItem('na2', { status: 'nextAction' }), baseItem('in1', { status: 'inbox' })]);

        const result = await getActiveNextActions(db, USER_ID);
        expect(result).toHaveLength(2);
    });

    it('hides items where ignoreBefore is in the future (tickler)', async () => {
        await seed([
            baseItem('na3', { status: 'nextAction', ignoreBefore: FAR_FUTURE }), // future → hidden
            baseItem('na4', { status: 'nextAction', ignoreBefore: FAR_PAST }), // past → visible
            baseItem('na5', { status: 'nextAction' }), // no tickler → visible
        ]);

        const result = await getActiveNextActions(db, USER_ID);
        const ids = result.map((i) => i._id);
        expect(ids).not.toContain('na3');
        expect(ids).toContain('na4');
        expect(ids).toContain('na5');
    });

    it('filters by energy level', async () => {
        await seed([baseItem('na6', { status: 'nextAction', energy: 'low' }), baseItem('na7', { status: 'nextAction', energy: 'high' })]);

        const result = await getActiveNextActions(db, USER_ID, { energy: 'low' });
        expect(result).toHaveLength(1);
        expect(result[0]?._id).toBe('na6');
    });

    it('filters by maxMinutes — excludes items with no time set and items over the limit', async () => {
        await seed([
            baseItem('na8', { status: 'nextAction', time: 15 }),
            baseItem('na9', { status: 'nextAction', time: 60 }),
            baseItem('na10', { status: 'nextAction' }), // no time set → excluded when maxMinutes is specified
        ]);

        const result = await getActiveNextActions(db, USER_ID, { maxMinutes: 30 });
        expect(result).toHaveLength(1);
        expect(result[0]?._id).toBe('na8');
    });

    it('filters by focus', async () => {
        await seed([
            baseItem('na11', { status: 'nextAction', focus: true }),
            baseItem('na12', { status: 'nextAction', focus: false }),
            baseItem('na13', { status: 'nextAction' }),
        ]);

        const focused = await getActiveNextActions(db, USER_ID, { focus: true });
        expect(focused.map((i) => i._id)).toEqual(['na11']);
    });

    it('filters by urgent', async () => {
        await seed([baseItem('na14', { status: 'nextAction', urgent: true }), baseItem('na15', { status: 'nextAction', urgent: false })]);

        const urgent = await getActiveNextActions(db, USER_ID, { urgent: true });
        expect(urgent).toHaveLength(1);
        expect(urgent[0]?._id).toBe('na14');
    });

    it('filters by workContextId', async () => {
        await seed([
            baseItem('na16', { status: 'nextAction', workContextIds: ['ctx-phone', 'ctx-desk'] }),
            baseItem('na17', { status: 'nextAction', workContextIds: ['ctx-desk'] }),
            baseItem('na18', { status: 'nextAction' }),
        ]);

        const result = await getActiveNextActions(db, USER_ID, { workContextId: 'ctx-phone' });
        expect(result).toHaveLength(1);
        expect(result[0]?._id).toBe('na16');
    });
});

// ── getUpcomingCalendarItems ───────────────────────────────────────────────────

describe('getUpcomingCalendarItems', () => {
    it('returns only calendar items sorted by timeStart ascending', async () => {
        await seed([
            baseItem('c1', { status: 'calendar', timeStart: '2025-07-10T09:00:00Z', timeEnd: '2025-07-10T10:00:00Z' }),
            baseItem('c2', { status: 'calendar', timeStart: '2025-07-01T09:00:00Z', timeEnd: '2025-07-01T10:00:00Z' }),
            baseItem('in1', { status: 'inbox' }),
        ]);

        const result = await getUpcomingCalendarItems(db, USER_ID);
        expect(result).toHaveLength(2);
        expect(result[0]?._id).toBe('c2'); // earlier date first
        expect(result[1]?._id).toBe('c1');
    });

    it('returns an empty array when there are no calendar items', async () => {
        await seed([baseItem('in2', { status: 'inbox' })]);
        expect(await getUpcomingCalendarItems(db, USER_ID)).toHaveLength(0);
    });
});

// ── getOverdueItems ────────────────────────────────────────────────────────────

describe('getOverdueItems', () => {
    it('returns nextAction and waitingFor items where expectedBy is in the past', async () => {
        await seed([
            baseItem('o1', { status: 'nextAction', expectedBy: FAR_PAST }), // past → overdue
            baseItem('o2', { status: 'waitingFor', expectedBy: FAR_PAST }), // past → overdue
            baseItem('o3', { status: 'nextAction', expectedBy: FAR_FUTURE }), // future → not overdue
            baseItem('o4', { status: 'nextAction' }), // no expectedBy → not overdue
            baseItem('o5', { status: 'inbox', expectedBy: FAR_PAST }), // wrong status → excluded
        ]);

        const result = await getOverdueItems(db, USER_ID);
        const ids = result.map((i) => i._id).sort();
        expect(ids).toEqual(['o1', 'o2']);
    });

    it('returns an empty array when nothing is overdue', async () => {
        await seed([baseItem('o6', { status: 'nextAction', expectedBy: FAR_FUTURE })]);
        expect(await getOverdueItems(db, USER_ID)).toHaveLength(0);
    });
});
