import { describe, expect, it } from 'vitest';
import { parseRoutinesSearch } from '../lib/routinesUrlParams';

describe('parseRoutinesSearch', () => {
    it('passes through a non-empty string query', () => {
        expect(parseRoutinesSearch({ q: 'water' })).toEqual({ q: 'water' });
    });

    it('drops an empty string', () => {
        expect(parseRoutinesSearch({ q: '' })).toEqual({ q: undefined });
    });

    it('drops a missing value', () => {
        expect(parseRoutinesSearch({})).toEqual({ q: undefined });
    });

    it('coerces JSON-parsed numbers and booleans back to the typed string', () => {
        // TanStack Router JSON-parses search values, so `?q=2024` arrives as the number 2024.
        expect(parseRoutinesSearch({ q: 2024 })).toEqual({ q: '2024' });
        expect(parseRoutinesSearch({ q: true })).toEqual({ q: 'true' });
    });

    it('strips junk values without crashing', () => {
        expect(parseRoutinesSearch({ q: { nested: 1 } })).toEqual({ q: undefined });
        expect(parseRoutinesSearch({ q: null })).toEqual({ q: undefined });
    });
});
