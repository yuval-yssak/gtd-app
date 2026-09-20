import type { BriefOrigin, ItemBriefInterface } from '../types/entities.js';

/**
 * Pure rules shared by the server and the client for the item-brief sidecar. MIRRORED
 * BYTE-FOR-BYTE in `client/src/lib/briefSource.ts` (parity fixture test on both sides) — change
 * both together, or a brief hashed on one side reads as stale on the other.
 */

/** Notes shorter than this (after trim) are not worth a brief: the card shows the title only. */
export const BRIEF_SKIP_MIN_NOTES_CHARS = 160;

/**
 * Derived view of a brief against the item's CURRENT content:
 *   - `none`        — no usable brief (no row, skipped row, or a model brief whose source moved on)
 *   - `fresh`       — the brief was produced from exactly this title + notes
 *   - `pinnedStale` — an authored (user/agent) brief whose source changed; shown with a marker
 */
export type BriefState = 'none' | 'fresh' | 'pinnedStale';

/**
 * cyrb53 (public-domain string hash, base-36 output) over `title + '\n' + notes`. Synchronous on
 * purpose — sha256 would force async hashing into client render paths.
 */
export function briefSourceHash(title: string, notes: string | undefined): string {
    const input = `${title}\n${notes ?? ''}`;
    // cyrb53 — mutable accumulators are inherent to the hash; kept as `let` deliberately.
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

/** Authored origins survive a source change (the sweeper never overwrites them). */
export function isPinnedOrigin(origin: BriefOrigin): boolean {
    return origin === 'user' || origin === 'agent';
}

type BriefSource = { title: string; notes?: string | undefined };
type BriefView = Pick<ItemBriefInterface, 'sourceHash' | 'origin' | 'text'>;

export function briefState(item: BriefSource, brief: BriefView | undefined | null): BriefState {
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
