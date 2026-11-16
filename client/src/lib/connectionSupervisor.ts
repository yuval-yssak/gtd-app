/**
 * Keeps the device connected to the server: live channels open, accounts known, session cookie
 * aligned, push registered, data caught up. Replaces a one-shot boot sequence in which one hung or
 * failed step left everything after it undone — on a spotty network at page load the live channels
 * might never open at all.
 *
 * Each repair pass runs every step that is not yet done, in order, and a step that fails or throws
 * only marks itself undone. Run repeatedly (by the repair retrier) until `isRepaired()`.
 */

/** The work the supervisor drives. Each `Promise<boolean>` step resolves true once it succeeded. */
export interface ConnectionRepairSteps {
    /** Opens a live channel for each known account lacking a usable one. Idempotent. */
    ensureLiveChannels: () => Promise<void>;
    areLiveChannelsUp: () => boolean;
    /** Refreshes the device's signed-in accounts from the server. */
    seedAccounts: () => Promise<boolean>;
    /** Points the API's session cookie at the account the user picked. */
    reconcileSessionCookie: () => Promise<boolean>;
    registerPush: () => Promise<boolean>;
    /** Starts whatever sync the device still needs. Fire-and-forget; progress shows in `isCaughtUp`. */
    syncIfBehind: () => void;
    isCaughtUp: () => boolean;
}

/**
 * A step still unsettled after this long counts as failed. Above the auth calls' own deadline (each
 * step makes one or two), so it only catches what nothing else bounds — e.g. the service worker's
 * `ready`, which never resolves when its install failed. Without it every later repair would join
 * the stuck pass and the supervisor would stop repairing anything.
 */
export const REPAIR_STEP_DEADLINE_MS = 20_000;

/** Whether a step succeeded in time; a thrown error or a hang counts as a failure, never as a stop. */
async function succeeded(step: () => Promise<boolean>): Promise<boolean> {
    const deadline: { timer?: ReturnType<typeof setTimeout> } = {};
    const giveUp = new Promise<false>((resolve) => {
        deadline.timer = setTimeout(() => resolve(false), REPAIR_STEP_DEADLINE_MS);
    });
    try {
        return await Promise.race([step(), giveUp]);
    } catch {
        return false;
    } finally {
        clearTimeout(deadline.timer);
    }
}

/** Runs a step whose only outcome is its effect, bounded and with failures swallowed like the rest. */
function attempted(step: () => Promise<void>): Promise<boolean> {
    return succeeded(async () => {
        await step();
        return true;
    });
}

export function createConnectionSupervisor(steps: ConnectionRepairSteps) {
    // Steps that, once done, stay done for the page session (or until the network is lost).
    const done = { accountsSeeded: false, cookieReconciled: false, pushRegistered: false };
    // Bumped when the network is lost: a step that settles afterwards belongs to the previous spell
    // and must not mark itself done for this one.
    const session = { generation: 0 };
    const pass: { inFlight: Promise<void> | null } = { inFlight: null };

    /** Runs a step unless already done, recording success only if no network loss intervened. */
    async function runOnce(key: keyof typeof done, step: () => Promise<boolean>): Promise<void> {
        if (done[key]) {
            return;
        }
        const generation = session.generation;
        const isDone = await succeeded(step);
        if (generation === session.generation) {
            done[key] = isDone;
        }
    }

    async function runRepairPass(): Promise<void> {
        // Channels first, for the accounts already on the device: nothing below may delay them.
        await attempted(steps.ensureLiveChannels);
        if (!done.accountsSeeded) {
            await runOnce('accountsSeeded', steps.seedAccounts);
            // An account signed in on another tab only now has a known id to open a channel for.
            await attempted(steps.ensureLiveChannels);
        }
        await runOnce('cookieReconciled', steps.reconcileSessionCookie);
        steps.syncIfBehind();
        await runOnce('pushRegistered', steps.registerPush);
    }

    /** One repair pass; overlapping calls share it. */
    function repair(): Promise<void> {
        pass.inFlight ??= runRepairPass().finally(() => {
            pass.inFlight = null;
        });
        return pass.inFlight;
    }

    /**
     * Push is left out on purpose: it is best-effort, and a browser that refuses it for good (push
     * disabled) would otherwise keep the retrier running for the tab's life. Passes that run for any
     * other reason still retry it.
     */
    function isRepaired(): boolean {
        return done.accountsSeeded && done.cookieReconciled && steps.areLiveChannelsUp() && steps.isCaughtUp();
    }

    /**
     * The network was lost: an offline account switch leaves the cookie behind, and a push
     * subscription may have lapsed. The account list does not change by being offline.
     */
    function forgetSessionSteps(): void {
        session.generation += 1;
        done.cookieReconciled = false;
        done.pushRegistered = false;
    }

    return { repair, isRepaired, forgetSessionSteps };
}

/** How the supervisor reads each account: checked with the server yet, and blocked on a fresh sign-in. */
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

interface SyncState {
    /** A full sync (flush, pull, calendar, routines) is running. */
    isSyncing: boolean;
    /** A catch-up pull pass is running. */
    isCatchingUp: boolean;
    hasFullSyncSucceeded: boolean;
    isCaughtUp: boolean;
}

/**
 * What the supervisor starts next. The full sync runs until one succeeds (it alone runs the calendar
 * sync and routine seeding), then catch-up pulls while behind. Nothing starts while a pass runs: two
 * orchestrators at once overlap past the session gate's timeout on a slow link — a second bootstrap,
 * cookie pivots under the first pass — and the next repair covers whatever the running one misses.
 */
export function nextSyncAction({ isSyncing, isCatchingUp, hasFullSyncSucceeded, isCaughtUp }: SyncState): 'none' | 'fullSync' | 'catchUp' {
    if (isSyncing || isCatchingUp) {
        return 'none';
    }
    if (!hasFullSyncSucceeded) {
        return 'fullSync';
    }
    return isCaughtUp ? 'none' : 'catchUp';
}
