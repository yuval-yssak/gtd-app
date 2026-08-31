/**
 * The shared tickler predicate — every active list (/next-actions, /waiting-for, /someday) and
 * the /tickler page itself judge snoozed-ness through this one function, so its boundary
 * semantics (hidden strictly BEFORE the date, visible ON it) are load-bearing for all of them.
 */
import { describe, expect, it } from 'vitest';
import { isTicklerHidden, TICKLER_STATUSES } from '../lib/ticklerVisibility';

describe('TICKLER_STATUSES', () => {
    it('locks the status set shared by the hiding pages, /tickler, and the Weekly Review stages', () => {
        // Every status a page filters on MUST be listed by /tickler (and vice versa) or a snoozed
        // item becomes unreachable. Widening/narrowing this set is a product decision — make it a
        // visible break here, not a silent drift between the mirrors.
        expect([...TICKLER_STATUSES].sort()).toEqual(['nextAction', 'somedayMaybe', 'waitingFor']);
    });
});

describe('isTicklerHidden', () => {
    const today = '2026-08-30';

    it('hides an item snoozed until a future date', () => {
        expect(isTicklerHidden({ ignoreBefore: '2026-08-31' }, today)).toBe(true);
    });

    it('reveals the item ON its ignoreBefore date — the boundary is strict', () => {
        // "ignore BEFORE" — the item is due the day the date arrives, not the day after.
        expect(isTicklerHidden({ ignoreBefore: '2026-08-30' }, today)).toBe(false);
    });

    it('reveals an item whose date has passed', () => {
        expect(isTicklerHidden({ ignoreBefore: '2026-08-29' }, today)).toBe(false);
    });

    it('never hides an item without ignoreBefore', () => {
        expect(isTicklerHidden({}, today)).toBe(false);
    });

    it('treats a blanked (empty-string) ignoreBefore as not snoozed', () => {
        // The editor's date input produces '' when cleared. The predicate guards on !== undefined
        // (a deliberate change from the old truthiness check) — pin that '' still means visible,
        // via string comparison ('' > any date is false), not via the guard.
        expect(isTicklerHidden({ ignoreBefore: '' }, today)).toBe(false);
    });
});
