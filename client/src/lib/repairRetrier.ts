/**
 * Retries a repair pass while the connection to the server is not fully up. On a choppy or hanging
 * connection nothing else retries reliably: the browser never fires `online` (it never reported
 * offline), a live channel can look connected while dead, and the user's own edits only push.
 *
 * The delay grows, then repeats at the longest step: at worst about 30 repair passes an hour per tab,
 * every request billed through the Cloudflare Worker — and only while something is still broken.
 */
export const REPAIR_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

interface RepairRetryOptions {
    /** Starts a repair pass. Fire-and-forget: the next check waits for its own delay either way. */
    repair: () => void;
    /** True once nothing needs repairing. */
    isRepaired: () => boolean;
}

function delayForAttempt(attemptIndex: number): number {
    const longest = REPAIR_RETRY_DELAYS_MS[REPAIR_RETRY_DELAYS_MS.length - 1] ?? 0;
    return REPAIR_RETRY_DELAYS_MS[attemptIndex] ?? longest;
}

export function createRepairRetrier({ repair, isRepaired }: RepairRetryOptions) {
    // One retry chain at a time; the index restarts once the connection is repaired.
    const chain: { timer: ReturnType<typeof setTimeout> | null; attemptIndex: number } = { timer: null, attemptIndex: 0 };

    const onDelayElapsed = () => {
        chain.timer = null;
        if (isRepaired()) {
            chain.attemptIndex = 0;
            return;
        }
        repair();
        chain.attemptIndex += 1;
        ensureRunning();
    };

    /** Starts the retry chain if something needs repair and no chain is already waiting. */
    function ensureRunning(): void {
        if (chain.timer !== null || isRepaired()) {
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
