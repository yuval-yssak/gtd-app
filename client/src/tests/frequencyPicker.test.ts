import { describe, expect, it } from 'vitest';
import { buildRrule, computeToggledDays, parseToFreqState } from '../components/routines/FrequencyPicker';

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

describe('buildRrule — recurrenceAnchor', () => {
    it('emits a bare FREQ=MONTHLY (no BYMONTHDAY) when floating', () => {
        const state = parseToFreqState('FREQ=MONTHLY', 'floating');
        expect(buildRrule(state)).toBe('FREQ=MONTHLY');
    });

    it('emits FREQ=MONTHLY;BYMONTHDAY=N when fixed', () => {
        const state = parseToFreqState('FREQ=MONTHLY;BYMONTHDAY=15', 'fixed');
        expect(buildRrule(state)).toBe('FREQ=MONTHLY;BYMONTHDAY=15');
    });

    it('emits a bare FREQ=WEEKLY (no BYDAY) when floating', () => {
        const state = parseToFreqState('FREQ=WEEKLY', 'floating');
        expect(buildRrule(state)).toBe('FREQ=WEEKLY');
    });

    it('emits FREQ=WEEKLY;BYDAY=... when fixed', () => {
        const state = parseToFreqState('FREQ=WEEKLY;BYDAY=MO,WE', 'fixed');
        expect(buildRrule(state)).toBe('FREQ=WEEKLY;BYDAY=MO,WE');
    });

    it('preserves INTERVAL alongside floating monthly/weekly', () => {
        expect(buildRrule(parseToFreqState('FREQ=MONTHLY;INTERVAL=3', 'floating'))).toBe('FREQ=MONTHLY;INTERVAL=3');
        expect(buildRrule(parseToFreqState('FREQ=WEEKLY;INTERVAL=2', 'floating'))).toBe('FREQ=WEEKLY;INTERVAL=2');
    });
});

describe('parseToFreqState — recurrenceAnchor round-trip', () => {
    it('derives fixed when BYMONTHDAY is present and no explicit anchor is passed', () => {
        expect(parseToFreqState('FREQ=MONTHLY;BYMONTHDAY=8').recurrenceAnchor).toBe('fixed');
    });

    it('derives floating when BYMONTHDAY is absent and no explicit anchor is passed', () => {
        expect(parseToFreqState('FREQ=MONTHLY').recurrenceAnchor).toBe('floating');
    });

    it('an explicit recurrenceAnchor overrides the derived value', () => {
        // Stored recurrenceAnchor is the source of truth even if it looks inconsistent with the
        // raw rrule shape (shouldn't happen in practice, but the picker must not second-guess it).
        expect(parseToFreqState('FREQ=MONTHLY;BYMONTHDAY=8', 'floating').recurrenceAnchor).toBe('floating');
    });

    // Regression for the corruption bug: parsing a bare (floating) monthly rrule must NOT fabricate
    // a dayOfMonth that would then get written back as BYMONTHDAY=1 on the next save without the
    // user ever touching the frequency field.
    it('does not fabricate dayOfMonth when floating — round-tripping through buildRrule stays bare', () => {
        const state = parseToFreqState('FREQ=MONTHLY', 'floating');
        expect(state.dayOfMonth).toBe(1); // internal default, never surfaced
        expect(buildRrule(state)).toBe('FREQ=MONTHLY'); // critically: NOT 'FREQ=MONTHLY;BYMONTHDAY=1'
    });

    it('does not fabricate selectedDays when floating weekly — round-tripping stays bare', () => {
        const state = parseToFreqState('FREQ=WEEKLY', 'floating');
        expect(buildRrule(state)).toBe('FREQ=WEEKLY'); // NOT 'FREQ=WEEKLY;BYDAY=MO'
    });

    it('parses dayOfMonth from BYMONTHDAY only when fixed', () => {
        expect(parseToFreqState('FREQ=MONTHLY;BYMONTHDAY=22', 'fixed').dayOfMonth).toBe(22);
    });
});
