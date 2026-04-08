import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getCalendarHorizonMonths, setCalendarHorizonMonths } from '../lib/calendarHorizon';

const HORIZON_KEY = 'gtd:calendarHorizonMonths';

// Node test environment has no localStorage — provide a minimal in-memory stand-in.
beforeAll(() => {
    if (typeof globalThis.localStorage === 'undefined') {
        const store = new Map<string, string>();
        globalThis.localStorage = {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => store.set(key, value),
            removeItem: (key: string) => store.delete(key),
            clear: () => store.clear(),
            get length() {
                return store.size;
            },
            key: () => null,
        };
    }
});

describe('calendarHorizon', () => {
    afterEach(() => {
        localStorage.removeItem(HORIZON_KEY);
    });

    it('returns default (2) when localStorage is empty', () => {
        expect(getCalendarHorizonMonths()).toBe(2);
    });

    it('returns the stored value for valid integers', () => {
        localStorage.setItem(HORIZON_KEY, '6');
        expect(getCalendarHorizonMonths()).toBe(6);
    });

    it('returns default for non-integer values', () => {
        localStorage.setItem(HORIZON_KEY, 'abc');
        expect(getCalendarHorizonMonths()).toBe(2);
    });

    it('returns default for out-of-range values', () => {
        localStorage.setItem(HORIZON_KEY, '0');
        expect(getCalendarHorizonMonths()).toBe(2);

        localStorage.setItem(HORIZON_KEY, '13');
        expect(getCalendarHorizonMonths()).toBe(2);
    });

    it('clamps values when setting', () => {
        setCalendarHorizonMonths(0);
        expect(getCalendarHorizonMonths()).toBe(1);

        setCalendarHorizonMonths(20);
        expect(getCalendarHorizonMonths()).toBe(12);
    });

    it('rounds fractional values when setting', () => {
        setCalendarHorizonMonths(3.7);
        expect(getCalendarHorizonMonths()).toBe(4);
    });

    it('round-trips correctly', () => {
        setCalendarHorizonMonths(9);
        expect(getCalendarHorizonMonths()).toBe(9);
    });
});
