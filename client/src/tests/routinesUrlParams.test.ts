import { describe, expect, it } from 'vitest';
import { parseRoutinesSearch } from '../lib/routinesUrlParams';

describe('parseRoutinesSearch', () => {
    it('passes through a valid non-default state', () => {
        expect(parseRoutinesSearch({ q: 'pool', tab: 'calendar', view: 'week' })).toEqual({ q: 'pool', tab: 'calendar', view: 'week' });
    });

    it('materializes defaults and unknowns as undefined so they stay out of the URL', () => {
        expect(parseRoutinesSearch({})).toEqual({ q: undefined, tab: undefined, view: undefined });
        // 'nextAction' and 'list' are the defaults — normalized away rather than echoed.
        expect(parseRoutinesSearch({ tab: 'nextAction', view: 'list' })).toEqual({ q: undefined, tab: undefined, view: undefined });
        expect(parseRoutinesSearch({ tab: 'junk', view: 42, q: '' })).toEqual({ q: undefined, tab: undefined, view: undefined });
    });

    it('coerces JSON-parsed numeric/boolean queries back to strings', () => {
        expect(parseRoutinesSearch({ q: 2024 })).toEqual({ q: '2024', tab: undefined, view: undefined });
    });
});
