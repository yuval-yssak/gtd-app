import { describe, expect, it } from 'vitest';
import { isRankOnlyRoutineChange } from '../lib/routineRankChange.js';
import type { RoutineInterface } from '../types/entities.js';

const base: RoutineInterface = {
    _id: 'r1',
    user: 'u1',
    title: 'Standup',
    routineType: 'calendar',
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    template: { notes: 'agenda' },
    active: true,
    rank: 'a0',
    createdTs: '2026-01-01T00:00:00.000Z',
    updatedTs: '2026-01-01T00:00:00.000Z',
};

describe('isRankOnlyRoutineChange', () => {
    it('is true when only rank and updatedTs moved', () => {
        expect(isRankOnlyRoutineChange(base, { ...base, rank: 'a1', updatedTs: '2026-02-01T00:00:00.000Z' })).toBe(true);
    });

    it('is true when a rank appears on a previously unranked routine', () => {
        const { rank: _rank, ...unranked } = base;
        expect(isRankOnlyRoutineChange(unranked, base)).toBe(true);
    });

    it('ignores key order — snapshots are built by different writers', () => {
        const reordered: RoutineInterface = {
            updatedTs: base.updatedTs,
            createdTs: base.createdTs,
            rank: 'a1',
            active: true,
            template: { notes: 'agenda' },
            rrule: base.rrule,
            routineType: 'calendar',
            title: base.title,
            user: base.user,
            _id: base._id,
        };
        expect(isRankOnlyRoutineChange(base, reordered)).toBe(true);
    });

    it('is false when anything else changed, nested fields included', () => {
        expect(isRankOnlyRoutineChange(base, { ...base, rank: 'a1', title: 'Daily standup' })).toBe(false);
        expect(isRankOnlyRoutineChange(base, { ...base, rank: 'a1', template: { notes: 'new agenda' } })).toBe(false);
    });

    it('is false when the rank did not change — a plain re-save is not a reorder', () => {
        expect(isRankOnlyRoutineChange(base, { ...base, updatedTs: '2026-02-01T00:00:00.000Z' })).toBe(false);
    });
});
