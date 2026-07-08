import { describe, expect, it } from 'vitest';
import { parseNextActionsSearch } from '../lib/nextActionsUrlParams';

describe('parseNextActionsSearch', () => {
    it('parses a fully-populated valid bag', () => {
        expect(parseNextActionsSearch({ context: 'c1', person: 'p1', energy: 'low', time: 30 })).toEqual({
            context: 'c1',
            person: 'p1',
            energy: 'low',
            time: 30,
        });
    });

    it('returns all-undefined for an empty bag so no params are serialized', () => {
        expect(parseNextActionsSearch({})).toEqual({ context: undefined, person: undefined, energy: undefined, time: undefined });
    });

    it('accepts time as a string (manually-typed URL) as well as a number (router JSON-parse)', () => {
        expect(parseNextActionsSearch({ time: '5' }).time).toBe(5);
        expect(parseNextActionsSearch({ time: 60 }).time).toBe(60);
    });

    it('strips time values outside the 5/30/60 options', () => {
        expect(parseNextActionsSearch({ time: 7 }).time).toBeUndefined();
        expect(parseNextActionsSearch({ time: 'abc' }).time).toBeUndefined();
    });

    it('strips invalid energy values', () => {
        expect(parseNextActionsSearch({ energy: 'bogus' }).energy).toBeUndefined();
        expect(parseNextActionsSearch({ energy: 42 }).energy).toBeUndefined();
    });

    it('strips empty-string and non-string ids', () => {
        expect(parseNextActionsSearch({ context: '', person: 17 })).toEqual({
            context: undefined,
            person: undefined,
            energy: undefined,
            time: undefined,
            q: undefined,
        });
    });

    it('passes through the in-page search query and coerces JSON-parsed scalars', () => {
        expect(parseNextActionsSearch({ q: 'milk' }).q).toBe('milk');
        // TanStack Router JSON-parses search values, so `?q=2024` arrives as the number 2024.
        expect(parseNextActionsSearch({ q: 2024 }).q).toBe('2024');
        expect(parseNextActionsSearch({ q: '' }).q).toBeUndefined();
    });
});
