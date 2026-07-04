/**
 * Debounced autosave scheduler, framework-free so it is unit-testable without rendering.
 *
 * Semantics:
 * - `onChange(value)` schedules a commit `delayMs` after the last change. A value that returns to
 *   the last-committed state cancels the pending commit (nothing to save).
 * - `flush()` commits immediately when dirty — callers wire it to blur/unmount so navigating away
 *   never loses the tail of a typing burst.
 * - Commits are skipped when the value equals the last-committed one (`isEqual`), so redundant
 *   writes never reach IDB / the sync queue — critical for entities with GCal pushback side effects.
 * - A "burst" is a run of commits that share one pre-edit baseline: the committed value from before
 *   the user started typing. `commit(value, baseline)` receives it so the caller can offer a single
 *   Undo that restores the whole burst, not just the last debounce tick. The burst ends when the
 *   caller invokes `endBurst()` (typically when the undo snackbar expires or is dismissed).
 * - `reset(value)` re-baselines after an external write (live-merge from another device, or an
 *   undo) so the controller doesn't treat the externally-applied value as a user edit.
 *
 * Commits are serialized: a flush that fires while a commit is in flight waits for it, then
 * re-checks dirtiness — two overlapping commits can never race each other's snapshots.
 */

export interface AutosaveControllerOptions<T> {
    /** Last persisted value — the initial baseline. */
    initial: T;
    /** Persists `value`. `baseline` is the pre-burst persisted value, for undo capture. */
    commit: (value: T, baseline: T) => Promise<void>;
    isEqual?: (a: T, b: T) => boolean;
    delayMs?: number;
}

export interface AutosaveController<T> {
    onChange(value: T): void;
    /** Commit now when dirty; resolves after the commit (or immediately when clean). */
    flush(): Promise<void>;
    /** Ends the current undo burst — the next commit captures a fresh baseline. */
    endBurst(): void;
    /** Adopts an externally persisted value as the new baseline; drops any pending commit. */
    reset(value: T): void;
    /** True when the latest value has not been committed yet. */
    isDirty(): boolean;
    /** The last value successfully committed (or adopted via reset). Used by live-merge callers
     *  to recognize their own committed write echoing back through sync (echo ≠ remote conflict). */
    lastCommitted(): T;
}

const DEFAULT_DELAY_MS = 800;

function jsonEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

export function createAutosaveController<T>({
    initial,
    commit,
    isEqual = jsonEqual,
    delayMs = DEFAULT_DELAY_MS,
}: AutosaveControllerOptions<T>): AutosaveController<T> {
    let lastCommitted = initial;
    let latest = initial;
    let burstBaseline: T | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;

    function clearTimer(): void {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    }

    async function commitIfDirty(): Promise<void> {
        // Wait out an in-flight commit first so snapshots can't interleave.
        while (inFlight) {
            await inFlight;
        }
        if (isEqual(latest, lastCommitted)) {
            return;
        }
        const value = latest;
        const baseline = burstBaseline ?? lastCommitted;
        burstBaseline = baseline;
        inFlight = commit(value, baseline)
            .then(() => {
                lastCommitted = value;
            })
            .finally(() => {
                inFlight = null;
            });
        await inFlight;
    }

    return {
        onChange(value: T): void {
            latest = value;
            clearTimer();
            if (isEqual(value, lastCommitted)) {
                return; // reverted to the persisted state — nothing to schedule
            }
            timer = setTimeout(() => {
                timer = null;
                void commitIfDirty();
            }, delayMs);
        },
        async flush(): Promise<void> {
            clearTimer();
            await commitIfDirty();
        },
        endBurst(): void {
            burstBaseline = null;
        },
        reset(value: T): void {
            clearTimer();
            lastCommitted = value;
            latest = value;
            burstBaseline = null;
        },
        isDirty(): boolean {
            return !isEqual(latest, lastCommitted);
        },
        lastCommitted(): T {
            return lastCommitted;
        },
    };
}
