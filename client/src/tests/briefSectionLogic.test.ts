import { describe, expect, it } from 'vitest';
import { decideBriefCommit, isBriefFirst } from '../components/itemEditor/briefSectionLogic';

describe('decideBriefCommit', () => {
    it('is a no-op when the trimmed field equals the seed (retyping the saved text writes nothing)', () => {
        expect(decideBriefCommit('Passport before the trip', 'Passport before the trip')).toEqual({ kind: 'noop' });
        expect(decideBriefCommit('  Passport before the trip  ', 'Passport before the trip')).toEqual({ kind: 'noop' });
        expect(decideBriefCommit('', '')).toEqual({ kind: 'noop' });
        expect(decideBriefCommit('   ', '')).toEqual({ kind: 'noop' });
    });

    it('sets the trimmed text when it differs from the seed', () => {
        expect(decideBriefCommit('  New brief ', '')).toEqual({ kind: 'set', text: 'New brief' });
        expect(decideBriefCommit('Rewritten', 'Original')).toEqual({ kind: 'set', text: 'Rewritten' });
    });

    it('clears (rather than storing an empty string) when a previously saved brief is emptied', () => {
        expect(decideBriefCommit('', 'Original')).toEqual({ kind: 'clear' });
        expect(decideBriefCommit('   ', 'Original')).toEqual({ kind: 'clear' });
    });
});

describe('isBriefFirst', () => {
    it('leads with the brief only in review presentation, with the preference on, and a brief to show', () => {
        expect(isBriefFirst('review', true, 'fresh')).toBe(true);
        expect(isBriefFirst('review', true, 'pinnedStale')).toBe(true);
    });

    it('falls back to the plain editor when there is no brief, the preference is off, or outside the review', () => {
        expect(isBriefFirst('review', true, 'none')).toBe(false);
        expect(isBriefFirst('review', false, 'fresh')).toBe(false);
        expect(isBriefFirst('edit', true, 'fresh')).toBe(false);
    });
});
