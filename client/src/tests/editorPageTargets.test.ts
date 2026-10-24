import { describe, expect, it } from 'vitest';
import { itemPageTargetFor } from '../components/itemEditor/useItemEditor';
import { routinePageTargetFor } from '../components/routineEditor/useRoutineEditor';
import type { StoredItem, StoredRoutine } from '../types/MyDB';

const ITEM: StoredItem = {
    _id: 'item-1',
    userId: 'user-1',
    status: 'inbox',
    title: 'Call the bank',
    createdTs: '2026-01-01T00:00:00.000Z',
    updatedTs: '2026-01-01T00:00:00.000Z',
};

const ROUTINE: StoredRoutine = {
    _id: 'routine-1',
    userId: 'user-1',
    title: 'Water the plants',
    routineType: 'nextAction',
    rrule: 'FREQ=WEEKLY',
    template: {},
    active: true,
    createdTs: '2026-01-01T00:00:00.000Z',
    updatedTs: '2026-01-01T00:00:00.000Z',
};

// The editor is always a page now: every list gesture resolves to one of these targets.
describe('itemPageTargetFor', () => {
    it('opens the item page on the item’s current status when no chip was clicked', () => {
        expect(itemPageTargetFor(ITEM, undefined)).toEqual({ to: '/item/$itemId', params: { itemId: 'item-1' }, search: { status: null } });
    });

    it('carries a clicked status chip to the page as the pre-selected status', () => {
        expect(itemPageTargetFor(ITEM, 'calendar').search).toEqual({ status: 'calendar' });
    });
});

describe('routinePageTargetFor', () => {
    it('opens an existing routine on its own page', () => {
        expect(routinePageTargetFor(ROUTINE)).toEqual({ to: '/routine/$routineId', params: { routineId: 'routine-1' } });
    });

    it('opens the create page when there is no routine yet', () => {
        expect(routinePageTargetFor(undefined)).toEqual({ to: '/routine/new' });
    });
});
