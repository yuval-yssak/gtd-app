import { describe, expect, it } from 'vitest';
import { rankSectionKeyOf } from '../lib/rankSections';

describe('rankSectionKeyOf', () => {
    it('dated lists are sectioned by status and expected day; the inbox and someday are one section each', () => {
        expect(rankSectionKeyOf({ status: 'nextAction', expectedBy: '2026-10-30' })).toBe('nextAction:2026-10-30');
        expect(rankSectionKeyOf({ status: 'nextAction' })).toBe('nextAction:undated');
        expect(rankSectionKeyOf({ status: 'waitingFor', expectedBy: '2026-10-30T09:00:00.000Z' })).toMatch(/^waitingFor:2026-10-/);
        expect(rankSectionKeyOf({ status: 'inbox', expectedBy: '2026-10-30' })).toBe('inbox');
        expect(rankSectionKeyOf({ status: 'somedayMaybe' })).toBe('somedayMaybe');
    });

    it('the calendar, done and trash have no manual order', () => {
        for (const status of ['calendar', 'done', 'trash'] as const) {
            expect(rankSectionKeyOf({ status })).toBeNull();
        }
    });
});
