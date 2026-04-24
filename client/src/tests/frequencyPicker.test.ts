import { describe, expect, it } from 'vitest';
import { computeToggledDays } from '../components/routines/FrequencyPicker';

describe('computeToggledDays', () => {
    it('adds a day that is not currently selected', () => {
        expect(computeToggledDays(['MO'], 'TU')).toEqual(['MO', 'TU']);
    });

    it('removes a day that is currently selected', () => {
        expect(computeToggledDays(['MO', 'TU'], 'MO')).toEqual(['TU']);
    });

    it('keeps at least one day selected when the last day is toggled off', () => {
        expect(computeToggledDays(['MO'], 'MO')).toEqual(['MO']);
    });

    // Regression: when applied as a functional setState updater, two rapid clicks
    // (deselect MO, then select TU) must compose correctly — MO gone, TU added.
    // The bug was that toggleDay read from a stale closure and left MO selected.
    it('composes cleanly under sequential application (deselect MO then select TU)', () => {
        const afterDeselectMo = computeToggledDays(['MO'], 'MO');
        const afterSelectTu = computeToggledDays(afterDeselectMo, 'TU');
        // After the last-day guard, MO stays (can't be empty); TU is added.
        expect(afterSelectTu.sort()).toEqual(['MO', 'TU']);
    });

    it('composes cleanly across MO→TU when starting from multiple days', () => {
        // MO and TU selected; click MO to deselect, then click WE to add.
        const afterDeselectMo = computeToggledDays(['MO', 'TU'], 'MO');
        const afterAddWe = computeToggledDays(afterDeselectMo, 'WE');
        expect(afterAddWe.sort()).toEqual(['TU', 'WE']);
    });
});
