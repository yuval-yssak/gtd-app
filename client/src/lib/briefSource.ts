import type { BriefOrigin, StoredItemBrief } from '../types/MyDB';

/**
 * Mirror of api-server/src/lib/briefSource.ts — the hash and the derived view MUST stay
 * byte-for-byte the same algorithm on both sides (a parity fixture test pins the outputs), because
 * a server-generated brief is only shown when its `sourceHash` equals the client's hash of the
 * item's current title + notes.
 */

/** Notes shorter than this (after trim) get a `skipped` brief row server-side — the title says it all. */
export const BRIEF_SKIP_MIN_NOTES_CHARS = 160;

export type BriefState = 'none' | 'fresh' | 'pinnedStale';

/**
 * cyrb53 — a fast synchronous 53-bit string hash; sha256 would force async hashing in render
 * paths. Mutable accumulators are inherent to the hash; kept as `let` deliberately.
 */
export function briefSourceHash(title: string, notes: string | undefined): string {
    const input = `${title}\n${notes ?? ''}`;
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < input.length; i++) {
        const ch = input.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Pinned briefs are authored (by the user or an agent): the sweeper never overwrites them. */
export function isPinnedOrigin(origin: BriefOrigin): boolean {
    return origin === 'user' || origin === 'agent';
}

type BriefSourceItem = { title: string; notes?: string | undefined };
type BriefStateInput = Pick<StoredItemBrief, 'sourceHash' | 'origin' | 'text'>;

/**
 * The derived view shared with the server:
 * - `none`        — no row, a skipped row, or a stale non-pinned row → show the notes preview
 * - `fresh`       — the row's hash matches the item's current text → show the brief
 * - `pinnedStale` — an authored row whose source moved on → show it with a "notes changed" marker
 */
export function briefState(item: BriefSourceItem, brief: BriefStateInput | undefined | null): BriefState {
    if (!brief || brief.text === null) {
        return 'none';
    }
    if (brief.sourceHash === briefSourceHash(item.title, item.notes)) {
        return 'fresh';
    }
    return isPinnedOrigin(brief.origin) ? 'pinnedStale' : 'none';
}

export function shouldSkipBrief(notes: string | undefined): boolean {
    return (notes ?? '').trim().length < BRIEF_SKIP_MIN_NOTES_CHARS;
}
