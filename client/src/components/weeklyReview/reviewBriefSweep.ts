import { type ReviewSweepResult, startReviewBriefSweep } from '../../api/briefApi';

/**
 * Fires the review-start brief sweep (`POST /maintenance/briefs/sweep-mine`) at most once per
 * review run, no matter how often the wizard mounts.
 *
 * The wizard remounts freely — React StrictMode double-invokes effects in dev, `AppNav` double-mounts
 * (see the reauth-banner memory), and the route swaps the wizard out for the pre-celebration sweep
 * screen and back. A ref would reset on each of those; the fired keys therefore live at module
 * level, keyed by `accountId + flow.startedTs` so a genuinely NEW review (a new `startedTs`, from
 * "Start" or "Start over") sweeps again while a resumed draft keeps its one sweep.
 */
const firedKeys = new Set<string>();

/**
 * Identity of one review run: the account whose briefs are swept, plus the run's start stamp.
 * Length-prefixed rather than separator-joined, so no separator choice has to be argued about
 * against whatever a future account id or stamp may contain.
 */
export function reviewSweepKey(accountId: string, startedTs: string): string {
    return `${accountId.length}:${accountId}${startedTs}`;
}

interface OwnerPinnedSweep {
    accountId: string;
    /** Only a device with a second logged-in account can have a drifted ambient session cookie. */
    isMultiAccountDevice: boolean;
    withOwnerSession: <T>(userId: string, task: () => Promise<T>) => Promise<T>;
    /** Injected so the pivot decision is testable without reaching the network; production uses the default. */
    requestSweep?: () => Promise<ReviewSweepResult>;
}

/**
 * Issues the request as the reviewing account. The session pivot is SKIPPED on a single-account
 * device: `withOwnerSession` takes the global session gate (`withSessionGate`) and spends a Better
 * Auth `listDeviceSessions` round trip only to discover there is nothing to pivot — which would
 * put this advisory call ahead of real sync work on every review open. With two or more accounts
 * the ambient cookie really can point elsewhere, and the pivot earns its cost.
 */
export function sweepPinnedToOwner({
    accountId,
    isMultiAccountDevice,
    withOwnerSession,
    requestSweep = startReviewBriefSweep,
}: OwnerPinnedSweep): Promise<ReviewSweepResult> {
    if (!isMultiAccountDevice) {
        return requestSweep();
    }
    return withOwnerSession(accountId, requestSweep);
}

export interface ReviewSweepPorts {
    /**
     * Whether to attempt the sweep at all. Checked BEFORE the key is claimed and before
     * `requestSweep` runs, because pinning the session is itself a network call
     * (`withOwnerSession` → Better Auth `listDeviceSessions`): an offline check inside the HTTP
     * wrapper would sit behind that call and never be reached. Offline therefore leaves the key
     * unclaimed, so the review sweeps normally as soon as connectivity returns.
     */
    isOnline: () => boolean;
    /** Issues the request, pinned to the reviewing account where that is needed. */
    requestSweep: () => Promise<ReviewSweepResult>;
    /** Where an unexpected rejection goes — the review never surfaces it to the user. */
    onError: (error: unknown) => void;
    /** Every settled outcome, so a silently failing sweep is visible in the console rather than dropped. */
    onOutcome: (outcome: ReviewSweepResult['outcome']) => void;
}

/**
 * Runs the sweep for `key` unless it already ran in this tab, or the device is offline. The key is
 * claimed SYNCHRONOUSLY, before awaiting, so two effects firing in the same tick collapse to one
 * request. An ATTEMPTED-but-failed sweep is not retried: the offline pre-check above means a
 * failure here is a real server/network fault, the 15-minute cron sweep is the backstop, and a
 * retry loop behind a review the user is already reading would be worse than slightly stale briefs.
 */
export async function runReviewBriefSweepOnce(key: string, { isOnline, requestSweep, onError, onOutcome }: ReviewSweepPorts): Promise<void> {
    if (firedKeys.has(key) || !isOnline()) {
        return;
    }
    firedKeys.add(key);
    try {
        onOutcome((await requestSweep()).outcome);
    } catch (error) {
        onError(error);
    }
}

/** Test-only: forget every fired key so each case starts from a clean module state. */
export function __resetReviewSweepGuardForTests(): void {
    firedKeys.clear();
}
