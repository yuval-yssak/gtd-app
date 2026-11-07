/**
 * The account the user picked in this page, while the hard reload that follows every pick is pending.
 * A sync pass moves IDB's active pointer to each account it syncs and puts the starting account back
 * when it ends. When a slow pass outlives the session gate's timeout, the user's switch runs WHILE
 * passes are still going: any later pivot, or a restore to the starting account, would write another
 * account over the pick — and the reload can kill the page between a pivot and its restore, leaving
 * IDB on whichever account a pass reached last. So once the user has picked, no pass in this page may
 * pivot again (`isPivotAllowed`), every restore hands the device to the pick (`accountToRestore`), and
 * readers that must not see a pivot (the account switcher) ask `intendedActiveUserId`.
 *
 * Relies on every pick ending in a hard reload: a pick whose reload never happens keeps this page's
 * sync frozen until the next reload, so a failed switch must `withdrawAccountChoice`.
 *
 * In-memory, so it covers the passes of the page that made the pick — the iOS PWA case, where there
 * is only one context. A slow pass in ANOTHER tab can still restore its own starting account over
 * this one; covering that needs a cross-tab signal (localStorage or BroadcastChannel).
 */
const pendingChoice: { userId: string | null } = { userId: null };

/** Starting accounts of the passes currently pivoting the active pointer, oldest first (a Set keeps insertion order). */
const pivotsInFlight = new Set<{ startingUserId: string | undefined }>();

export function recordAccountChoice(userId: string): void {
    pendingChoice.userId = userId;
}

/** The pick's reload will not happen (the switch failed): this page syncs and restores as before. */
export function withdrawAccountChoice(): void {
    pendingChoice.userId = null;
}

export function isPivotAllowed(): boolean {
    return pendingChoice.userId === null;
}

/** The account a finishing pass hands the device back to: the user's pick, else the one it started on. */
export function accountToRestore(startingUserId: string | undefined): string | undefined {
    return pendingChoice.userId ?? startingUserId;
}

/** Runs `pivot` — a pass that moves the active pointer away and back — registered as in flight until it ends. */
export async function whilePivoting<T>(startingUserId: string | undefined, pivot: () => Promise<T>): Promise<T> {
    const entry = { startingUserId };
    pivotsInFlight.add(entry);
    try {
        return await pivot();
    } finally {
        pivotsInFlight.delete(entry);
    }
}

/**
 * The account the user means to be on, given the one IDB holds. While a pass pivots, IDB names the
 * account being synced; the oldest pass in flight started on the user's account, and a pick wins
 * over both.
 */
export function intendedActiveUserId(storedUserId: string | undefined): string | undefined {
    const [oldestPivot] = pivotsInFlight;
    return accountToRestore(oldestPivot ? oldestPivot.startingUserId : storedUserId);
}

/** Test-only: forget the pick and any registered pivots so cases do not leak into each other. */
export function resetAccountChoicesForTests(): void {
    pendingChoice.userId = null;
    pivotsInFlight.clear();
}
