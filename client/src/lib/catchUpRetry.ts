/**
 * Retries the catch-up pull while the device is behind the server. Nothing else retries a failed
 * pull on a choppy connection: the browser never fires `online` (it never reported offline), a live
 * channel can look connected while dead, and the user's own edits only push. Without this a device
 * could show "Not verified" data indefinitely.
 *
 * The delay grows, then repeats at the longest step: at worst about 30 catch-up passes an hour per
 * tab (each a session check plus a flush and pull per account), every request billed through the
 * Cloudflare Worker — and only while some account that can sync is still unverified.
 */
export const CATCH_UP_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

/** How the retrier reads each account: checked with the server yet, and blocked on a fresh sign-in. */
interface AccountSyncState {
    isVerified: (userId: string) => boolean;
    needsReauth: (userId: string) => boolean;
}

/**
 * Caught up once every account that CAN sync has been checked with the server. An account waiting
 * for the user to sign in again fails every pull until then; counting it would retry forever.
 */
export function areAccountsCaughtUp(userIds: readonly string[], { isVerified, needsReauth }: AccountSyncState): boolean {
    return userIds.every((userId) => needsReauth(userId) || isVerified(userId));
}

interface CatchUpRetryOptions {
    /** Starts a catch-up pull. Fire-and-forget: the next check waits for its own delay either way. */
    attempt: () => void;
    /** True once a pull from the server has landed for every account on the device. */
    isCaughtUp: () => boolean;
}

function delayForAttempt(attemptIndex: number): number {
    const longest = CATCH_UP_RETRY_DELAYS_MS[CATCH_UP_RETRY_DELAYS_MS.length - 1] ?? 0;
    return CATCH_UP_RETRY_DELAYS_MS[attemptIndex] ?? longest;
}

export function createCatchUpRetrier({ attempt, isCaughtUp }: CatchUpRetryOptions) {
    // One retry chain at a time; the index restarts once the device has caught up.
    const chain: { timer: ReturnType<typeof setTimeout> | null; attemptIndex: number } = { timer: null, attemptIndex: 0 };

    const onDelayElapsed = () => {
        chain.timer = null;
        if (isCaughtUp()) {
            chain.attemptIndex = 0;
            return;
        }
        attempt();
        chain.attemptIndex += 1;
        ensureRunning();
    };

    /** Starts the retry chain if the device is behind and no chain is already waiting. */
    function ensureRunning(): void {
        if (chain.timer !== null || isCaughtUp()) {
            return;
        }
        chain.timer = setTimeout(onDelayElapsed, delayForAttempt(chain.attemptIndex));
    }

    function stop(): void {
        if (chain.timer !== null) {
            clearTimeout(chain.timer);
        }
        chain.timer = null;
        chain.attemptIndex = 0;
    }

    return { ensureRunning, stop };
}
