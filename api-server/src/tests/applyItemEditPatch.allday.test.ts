import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { applyItemEditPatch } from '../lib/reassignEntity.js';
import type { ItemInterface } from '../types/entities.js';

function makeItem(overrides: Partial<ItemInterface>): ItemInterface {
    const now = dayjs().toISOString();
    return {
        _id: 'i1',
        user: 'u1',
        status: 'calendar',
        title: 'evt',
        timeStart: '2026-05-27',
        timeEnd: '2026-05-28',
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
}

describe('applyItemEditPatch — allDay branch', () => {
    it('allDay: true in the patch sets the flag on the resulting item', () => {
        const item = makeItem({});
        const next = applyItemEditPatch(item, { allDay: true });
        expect(next.allDay).toBe(true);
    });

    it('allDay: false deletes a previously-set flag (not stored as false)', () => {
        const item = makeItem({ allDay: true });
        const next = applyItemEditPatch(item, { allDay: false });
        expect(next.allDay).toBeUndefined();
        expect('allDay' in next).toBe(false);
    });

    it('absent allDay in the patch preserves the existing value', () => {
        const item = makeItem({ allDay: true });
        const next = applyItemEditPatch(item, { title: 'Renamed' });
        expect(next.allDay).toBe(true);
    });

    it('absent allDay on an item without the flag stays absent', () => {
        const item = makeItem({});
        const next = applyItemEditPatch(item, { title: 'Renamed' });
        expect(next.allDay).toBeUndefined();
    });

    it('undefined patch returns the item unchanged (includes allDay)', () => {
        const item = makeItem({ allDay: true });
        const next = applyItemEditPatch(item, undefined);
        expect(next.allDay).toBe(true);
        expect(next).toBe(item);
    });
});
