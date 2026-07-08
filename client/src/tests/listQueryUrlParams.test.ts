import { describe, expect, it } from 'vitest';
import { parseListQuerySearch } from '../lib/listQueryUrlParams';

describe('parseListQuerySearch', () => {
    it('passes through a non-empty string query', () => {
        expect(parseListQuerySearch({ q: 'water' })).toEqual({ q: 'water' });
    });

    it('drops an empty string', () => {
        expect(parseListQuerySearch({ q: '' })).toEqual({ q: undefined });
    });

    it('drops a missing value', () => {
        expect(parseListQuerySearch({})).toEqual({ q: undefined });
    });

    it('coerces JSON-parsed numbers and booleans back to the typed string', () => {
        // TanStack Router JSON-parses search values, so `?q=2024` arrives as the number 2024.
        expect(parseListQuerySearch({ q: 2024 })).toEqual({ q: '2024' });
        expect(parseListQuerySearch({ q: true })).toEqual({ q: 'true' });
    });

    it('strips junk values without crashing', () => {
        expect(parseListQuerySearch({ q: { nested: 1 } })).toEqual({ q: undefined });
        expect(parseListQuerySearch({ q: null })).toEqual({ q: undefined });
    });
});
