import { describe, expect, it } from 'vitest';
import { parseWaitingForSearch } from '../lib/waitingForUrlParams';

describe('parseWaitingForSearch', () => {
    it('passes through "date"', () => {
        expect(parseWaitingForSearch({ sortBy: 'date' })).toEqual({ sortBy: 'date' });
    });

    it('drops "person" so the default is omitted from the URL', () => {
        expect(parseWaitingForSearch({ sortBy: 'person' })).toEqual({ sortBy: undefined });
    });

    it('drops a missing value', () => {
        expect(parseWaitingForSearch({})).toEqual({ sortBy: undefined });
    });

    it('strips junk values without crashing', () => {
        expect(parseWaitingForSearch({ sortBy: 'bogus' })).toEqual({ sortBy: undefined });
        expect(parseWaitingForSearch({ sortBy: null })).toEqual({ sortBy: undefined });
        expect(parseWaitingForSearch({ sortBy: 2024 })).toEqual({ sortBy: undefined });
    });
});
