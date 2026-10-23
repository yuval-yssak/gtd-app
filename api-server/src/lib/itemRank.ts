import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

/**
 * Fractional-indexing keys for the Next Actions priority order (`ItemInterface.rank`).
 *
 * MIRROR: `client/src/lib/itemRank.ts` — same functions, same semantics; both sides run the
 * identical fixture table (`tests/itemRankParity.test.ts`). Change both together.
 *
 * Keys come from `fractional-indexing` (base-62 alphabet `0-9A-Za-z`, ASCII-ordered). They are
 * compared by code unit, NEVER by `localeCompare`: ICU collation would sort `a0` before `B0`, and
 * the library's alphabet puts digits before uppercase before lowercase.
 */

/** A minted key longer than this is a signal to re-key its section (`rebalanceSection`). */
export const RANK_TOO_LONG_THRESHOLD = 40;

/**
 * A key strictly between `above` and `below` (either end open). The library THROWS on equal keys
 * and, for an inverted pair (`above > below`), returns a key that is NOT between them — so every
 * caller must guarantee `above < below` first (`ensureSectionRanked` re-keys the section when its
 * sequence is not strictly increasing). The throw is deliberately not swallowed.
 */
export function rankBetween(above: string | null | undefined, below: string | null | undefined): string {
    return generateKeyBetween(above ?? null, below ?? null);
}

/**
 * The key a freshly created item gets: strictly below the lowest existing key of its owner, so it
 * sorts to the top of whatever date section it lands in. With no existing key it is the library's
 * origin (`a0`). Prepends shorten the integer head and grow only logarithmically.
 */
export function topRank(minExisting: string | null | undefined): string {
    return generateKeyBetween(null, minExisting ?? null);
}

/** `n` strictly increasing keys starting at the origin (`a0`, `a1`, …) — used to (re)key a whole section. */
export function evenlySpacedRanks(n: number): string[] {
    return generateNKeysBetween(null, null, n);
}

/** `n` strictly increasing keys strictly between `above` and `below` (either end open) — re-keying a run. Same contract as `rankBetween`. */
export function ranksBetween(above: string | null | undefined, below: string | null | undefined, n: number): string[] {
    return generateNKeysBetween(above ?? null, below ?? null, n);
}

/** `n` strictly increasing keys all below `minExisting` (the bulk paths: import, bulk create). */
export function topRanks(minExisting: string | null | undefined, n: number): string[] {
    return generateNKeysBetween(null, minExisting ?? null, n);
}

/** The key at `idx` of a minted list; the library yields exactly the count asked for, so a miss is a broken invariant. */
export function rankAt(ranks: readonly string[], idx: number): string {
    const rank = ranks[idx];
    if (rank === undefined) {
        throw new Error(`rank list has no index ${idx} (length ${ranks.length})`);
    }
    return rank;
}

/**
 * True when `key` is a well-formed fractional-indexing key the library can mint around. A
 * malformed stored key (`'0'`, `'A'`, `'a00'`, …) would make every later mint for that user throw,
 * so the op schema refines on this and `topRankForUser` falls back past it.
 */
export function isValidRank(key: string): boolean {
    if (!/^[0-9A-Za-z]+$/.test(key)) {
        return false;
    }
    try {
        generateKeyBetween(key, null);
        return true;
    } catch {
        return false;
    }
}

/** Code-unit comparison (`a < b`), the only valid order for these keys. */
export function compareRank(a: string, b: string): number {
    if (a < b) {
        return -1;
    }
    return a > b ? 1 : 0;
}

export function isRankTooLong(key: string): boolean {
    return key.length > RANK_TOO_LONG_THRESHOLD;
}

/** True when every key is strictly greater than the one before it (no equal keys, no inversions). */
export function isStrictlyIncreasing(keys: ReadonlyArray<string>): boolean {
    return keys.every((key, idx) => {
        const previous = keys[idx - 1];
        return previous === undefined || compareRank(previous, key) < 0;
    });
}
