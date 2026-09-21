import { describe, expect, it } from 'vitest';
import { BRIEF_SKIP_MIN_NOTES_CHARS, briefSourceHash, briefState, isPinnedOrigin, shouldSkipBrief } from '../lib/briefSource.js';

/**
 * PARITY FIXTURES — the client test (`client/src/lib/briefSource.test.ts`) asserts the identical
 * literal table. A hash that drifts on either side makes every brief read as stale over there.
 * Do not change the inputs; if the hash function ever changes, regenerate BOTH tables together.
 */
const PARITY_TABLE: ReadonlyArray<[title: string, notes: string | undefined, hash: string]> = [
    ['', undefined, '1jwkt08uwi3'],
    ['Call dentist', undefined, '1qbimzjo0na'],
    ['Call dentist', 'ask about insurance', '1pd6dfdanbz'],
    ['שלום', 'עולם', '1m0kdvmh0ma'],
    ['a', 'b\nc', 'ftljxrqx8j'],
];

describe('briefSourceHash', () => {
    it.each(PARITY_TABLE)('parity fixture: hash(%j, %j) === %s', (title, notes, expected) => {
        expect(briefSourceHash(title, notes)).toBe(expected);
    });

    it('is deterministic and treats undefined notes like empty notes', () => {
        expect(briefSourceHash('x', 'y')).toBe(briefSourceHash('x', 'y'));
        expect(briefSourceHash('x', undefined)).toBe(briefSourceHash('x', ''));
    });

    it('separates title from notes with a newline so the boundary moves the hash', () => {
        // Same concatenated characters, different split → different input string → different hash.
        expect(briefSourceHash('ab', 'c')).not.toBe(briefSourceHash('a', 'bc'));
    });
});

describe('isPinnedOrigin', () => {
    it('pins authored origins only', () => {
        expect(isPinnedOrigin('user')).toBe(true);
        expect(isPinnedOrigin('agent')).toBe(true);
        expect(isPinnedOrigin('model')).toBe(false);
        expect(isPinnedOrigin('skipped')).toBe(false);
    });
});

describe('briefState', () => {
    const item = { title: 'Call dentist', notes: 'ask about insurance' };
    const freshHash = briefSourceHash(item.title, item.notes);

    it('no row → none', () => {
        expect(briefState(item, undefined)).toBe('none');
        expect(briefState(item, null)).toBe('none');
    });

    it('matching hash → fresh for every text-bearing origin', () => {
        expect(briefState(item, { sourceHash: freshHash, origin: 'model', text: 'x' })).toBe('fresh');
        expect(briefState(item, { sourceHash: freshHash, origin: 'user', text: 'x' })).toBe('fresh');
        expect(briefState(item, { sourceHash: freshHash, origin: 'agent', text: 'x' })).toBe('fresh');
    });

    it('stale hash → pinnedStale for authored origins, none for model', () => {
        expect(briefState(item, { sourceHash: 'stale', origin: 'user', text: 'x' })).toBe('pinnedStale');
        expect(briefState(item, { sourceHash: 'stale', origin: 'agent', text: 'x' })).toBe('pinnedStale');
        expect(briefState(item, { sourceHash: 'stale', origin: 'model', text: 'x' })).toBe('none');
    });

    it('a text-less row whose hash matches is declined — the decision stands for exactly this text', () => {
        // Both text-less origins land here; the caller words the caption from `origin`.
        expect(briefState(item, { sourceHash: freshHash, origin: 'skipped', text: null })).toBe('declined');
        expect(briefState(item, { sourceHash: freshHash, origin: 'model', text: null })).toBe('declined');
    });

    it('a text-less row whose hash moved on lapses back to none, so the sweep reconsiders it', () => {
        expect(briefState(item, { sourceHash: 'stale', origin: 'skipped', text: null })).toBe('none');
        expect(briefState(item, { sourceHash: 'stale', origin: 'model', text: null })).toBe('none');
    });

    it('recomputes against the item passed in — editing notes flips fresh to none/pinnedStale', () => {
        const edited = { ...item, notes: `${item.notes} and pricing` };
        expect(briefState(edited, { sourceHash: freshHash, origin: 'model', text: 'x' })).toBe('none');
        expect(briefState(edited, { sourceHash: freshHash, origin: 'user', text: 'x' })).toBe('pinnedStale');
    });
});

describe('shouldSkipBrief', () => {
    it(`skips below ${BRIEF_SKIP_MIN_NOTES_CHARS} chars and keeps at the threshold`, () => {
        expect(shouldSkipBrief('x'.repeat(BRIEF_SKIP_MIN_NOTES_CHARS - 1))).toBe(true);
        expect(shouldSkipBrief('x'.repeat(BRIEF_SKIP_MIN_NOTES_CHARS))).toBe(false);
    });

    it('skips missing, empty and whitespace-only notes (trim before counting)', () => {
        expect(shouldSkipBrief(undefined)).toBe(true);
        expect(shouldSkipBrief('')).toBe(true);
        expect(shouldSkipBrief(' '.repeat(BRIEF_SKIP_MIN_NOTES_CHARS + 10))).toBe(true);
        expect(shouldSkipBrief(`  ${'x'.repeat(BRIEF_SKIP_MIN_NOTES_CHARS)}  `)).toBe(false);
    });
});
