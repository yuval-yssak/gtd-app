import { describe, expect, it } from 'vitest';
import { BRIEF_SKIP_MIN_NOTES_CHARS, briefSourceHash, briefState, isPinnedOrigin, shouldSkipBrief } from '../lib/briefSource';
import type { BriefOrigin } from '../types/MyDB';

/**
 * Parity fixture — the SAME literal table lives in api-server/src/tests/briefSource.test.ts. The
 * expected hashes below are the pinned outputs of the shared cyrb53 algorithm; a change on either
 * side that alters any of them breaks the "show a model brief only when its hash matches" rule.
 */
const PARITY_FIXTURE: ReadonlyArray<readonly [title: string, notes: string | undefined, expected: string]> = [
    ['', undefined, '1jwkt08uwi3'],
    ['Call dentist', undefined, '1qbimzjo0na'],
    ['Call dentist', 'ask about insurance', '1pd6dfdanbz'],
    ['שלום', 'עולם', '1m0kdvmh0ma'],
    ['a', 'b\nc', 'ftljxrqx8j'],
];

describe('briefSourceHash', () => {
    it.each(PARITY_FIXTURE)('parity fixture: hash(%j, %j) === %s', (title, notes, expected) => {
        expect(briefSourceHash(title, notes)).toBe(expected);
    });

    it('is deterministic and base36', () => {
        const first = briefSourceHash('Renew passport', 'Form half filled');
        expect(briefSourceHash('Renew passport', 'Form half filled')).toBe(first);
        expect(first).toMatch(/^[0-9a-z]+$/);
    });

    it('treats undefined notes and empty notes as the same source', () => {
        expect(briefSourceHash('Title', undefined)).toBe(briefSourceHash('Title', ''));
    });

    it('separates title from notes with a newline so shifting text across the boundary changes the hash', () => {
        expect(briefSourceHash('ab', 'c')).not.toBe(briefSourceHash('a', 'bc'));
    });
});

describe('isPinnedOrigin', () => {
    it.each<[BriefOrigin, boolean]>([
        ['user', true],
        ['agent', true],
        ['model', false],
        ['skipped', false],
    ])('%s → %s', (origin, expected) => {
        expect(isPinnedOrigin(origin)).toBe(expected);
    });
});

describe('briefState', () => {
    const item = { title: 'Renew passport', notes: 'Form is half filled; need photos.' };
    const freshHash = briefSourceHash(item.title, item.notes);
    const staleHash = briefSourceHash(item.title, 'older notes');

    it('none when there is no row', () => {
        expect(briefState(item, undefined)).toBe('none');
        expect(briefState(item, null)).toBe('none');
    });

    it('none for a skipped row even when its hash matches', () => {
        expect(briefState(item, { sourceHash: freshHash, origin: 'skipped', text: null })).toBe('none');
    });

    it.each<BriefOrigin>(['model', 'user', 'agent'])('fresh when the hash matches (origin %s)', (origin) => {
        expect(briefState(item, { sourceHash: freshHash, origin, text: 'Passport before the trip' })).toBe('fresh');
    });

    it.each<BriefOrigin>(['user', 'agent'])('pinnedStale when the hash mismatches and the origin is pinned (%s)', (origin) => {
        expect(briefState(item, { sourceHash: staleHash, origin, text: 'Passport before the trip' })).toBe('pinnedStale');
    });

    it('none when the hash mismatches on a model brief (degrades to the notes preview)', () => {
        expect(briefState(item, { sourceHash: staleHash, origin: 'model', text: 'Passport before the trip' })).toBe('none');
    });

    it("only a null text marks a skipped row — '' is a (hash-matching) brief; the write boundary (setUserBrief) never stores ''", () => {
        // Mirrors the server rule exactly; keep the two in lockstep rather than special-casing '' here.
        expect(briefState(item, { sourceHash: freshHash, origin: 'user', text: '' })).toBe('fresh');
    });

    it('reads title-only items (no notes) against the undefined-notes hash', () => {
        const titleOnly = { title: 'Call dentist' };
        expect(briefState(titleOnly, { sourceHash: briefSourceHash('Call dentist', undefined), origin: 'user', text: 'Book the cleaning' })).toBe('fresh');
    });
});

describe('shouldSkipBrief', () => {
    it('skips undefined / empty / whitespace-only notes', () => {
        expect(shouldSkipBrief(undefined)).toBe(true);
        expect(shouldSkipBrief('')).toBe(true);
        expect(shouldSkipBrief('   \n  ')).toBe(true);
    });

    it(`skips at ${BRIEF_SKIP_MIN_NOTES_CHARS - 1} chars and generates at ${BRIEF_SKIP_MIN_NOTES_CHARS}`, () => {
        expect(shouldSkipBrief('x'.repeat(BRIEF_SKIP_MIN_NOTES_CHARS - 1))).toBe(true);
        expect(shouldSkipBrief('x'.repeat(BRIEF_SKIP_MIN_NOTES_CHARS))).toBe(false);
    });

    it('measures after trim — surrounding whitespace does not count toward the threshold', () => {
        expect(shouldSkipBrief(`  ${'x'.repeat(BRIEF_SKIP_MIN_NOTES_CHARS - 1)}  `)).toBe(true);
    });
});
