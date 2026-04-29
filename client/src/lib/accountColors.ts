import type { StoredAccount } from '../types/MyDB';

/**
 * Fixed 8-hue palette for tagging entities by owning account in the unified view.
 * Each colour was chosen to be readable as a Chip background under both the light and
 * dark MUI themes (low saturation, mid lightness). Order is deliberate: the first
 * colour goes to the oldest-added account, so a user signing in with their primary
 * email first always gets the same colour. Beyond 8 accounts the palette wraps modulo;
 * we never expect that many accounts on one device but the wrap keeps the function total.
 */
export const ACCOUNT_COLOR_PALETTE = ['#1976d2', '#9c27b0', '#2e7d32', '#ed6c02', '#0288d1', '#d32f2f', '#7b1fa2', '#5d4037'] as const;

const FALLBACK_COLOR: string = ACCOUNT_COLOR_PALETTE[0];

/**
 * Maps a userId to a deterministic colour from the palette. Sorts the input accounts
 * by `addedAt` (ascending) so the assignment is stable for any given user across renders,
 * regardless of the order callers pass `allAccounts` in. Accounts not present in the
 * `allAccounts` list (e.g. a stale userId from a signed-out account) return the first
 * palette colour rather than throw, since rendering should never fail on such drift.
 */
export function getAccountColor(userId: string, allAccounts: StoredAccount[]): string {
    const sorted = [...allAccounts].sort((a, b) => a.addedAt - b.addedAt);
    const index = sorted.findIndex((a) => a.id === userId);
    if (index === -1) {
        return FALLBACK_COLOR;
    }
    // Modulo so users beyond the palette length still get a deterministic, valid colour.
    return ACCOUNT_COLOR_PALETTE[index % ACCOUNT_COLOR_PALETTE.length] ?? FALLBACK_COLOR;
}
