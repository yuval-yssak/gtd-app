/**
 * Pure decision helpers backing the sync indicators in AppDataProvider. Extracted so the
 * branch logic is unit-testable without standing up the provider's React/IDB lifecycle (the
 * indicators' visible behavior is covered by the Playwright e2e specs).
 */

/**
 * Whether a fresh-launch skeleton should be raised for the active account. True only when online
 * AND the account has no sync cursor yet — i.e. the very first bootstrap, the window where IDB is
 * genuinely empty. A returning device (cursor present) has cached items and must not flash a
 * skeleton; an offline device can't bootstrap so there's nothing to wait for.
 */
export function shouldRaiseInitialSync({ isOnline, hasCursor }: { isOnline: boolean; hasCursor: boolean }): boolean {
    return isOnline && !hasCursor;
}

/** Deterministic, non-random placeholder-row widths so the skeleton doesn't reshuffle on re-render. */
export const SKELETON_ROW_WIDTHS = ['85%', '60%', '72%', '50%', '78%', '65%'] as const;

/** Cycles through SKELETON_ROW_WIDTHS by row index — always in-range, never undefined. */
export function skeletonRowWidth(rowIndex: number): string {
    return SKELETON_ROW_WIDTHS[rowIndex % SKELETON_ROW_WIDTHS.length] ?? SKELETON_ROW_WIDTHS[0];
}
