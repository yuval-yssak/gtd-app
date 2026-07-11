/**
 * Module-level store driving the blocking SyncRecoveryDialog — the recovery UX for a device the
 * server reaped after >30 days offline (GET /sync/pull → 409 bootstrapRequired). Module scope, NOT
 * React context state, for the same reason as `accountReauthEvents.ts`: AppNav double-mounts its
 * children (permanent + keepMounted temporary drawer), so per-component state would diverge across
 * instances. A single shared store keeps every mount rendering the same recovery phase.
 *
 * Phases:
 * - `idle`           — no recovery in progress; dialog hidden.
 * - `case1Syncing`   — no queued offline ops: auto-bootstrap is running, dialog shows a spinner.
 * - `case2Choice`    — queued offline ops exist: user must choose push / discard (+ optional export).
 * - `flushing`       — Case-2 "push" chosen: the queued ops are being flushed to the server.
 * - `flushFailed`    — the flush was rejected (whole batch) or network-failed: HALTED before
 *                       bootstrap; user may retry, export, or explicitly discard.
 * - `bootstrapping`  — Case-2 path: flush/discard done, full bootstrap in flight.
 * - `bootstrapFailed`— a bootstrap attempt threw; shown with a retry so a transient network error
 *                       never leaves the app locked forever.
 */
export type SyncRecoveryState =
    | { phase: 'idle' }
    | { phase: 'case1Syncing'; userId: string }
    | { phase: 'case2Choice'; userId: string; queuedOpCount: number }
    | { phase: 'flushing'; userId: string; queuedOpCount: number }
    | { phase: 'flushFailed'; userId: string; queuedOpCount: number; errorMessage: string; failedOpSummaries: string[] }
    | { phase: 'bootstrapping'; userId: string }
    | { phase: 'bootstrapFailed'; userId: string; errorMessage: string };

export const SYNC_RECOVERY_IDLE: SyncRecoveryState = { phase: 'idle' };

let state: SyncRecoveryState = SYNC_RECOVERY_IDLE;
const listeners = new Set<() => void>();

/** useSyncExternalStore getSnapshot — referentially stable between `setSyncRecoveryState` calls. */
export function getSyncRecoveryState(): SyncRecoveryState {
    return state;
}

/** useSyncExternalStore subscribe — registers a re-render callback, returns the unsubscribe. */
export function subscribeSyncRecovery(onChange: () => void): () => void {
    listeners.add(onChange);
    return () => {
        listeners.delete(onChange);
    };
}

export function setSyncRecoveryState(next: SyncRecoveryState): void {
    state = next;
    for (const notify of listeners) {
        notify();
    }
}

/**
 * Enters the Case-2 choice phase, but only from `idle` — a second reaped account detected while a
 * recovery dialog is already active must not clobber the in-progress state. The skipped account is
 * re-detected on the next sync pass once the current recovery completes.
 */
export function enterCase2Recovery(userId: string, queuedOpCount: number): void {
    if (state.phase !== 'idle') {
        return;
    }
    setSyncRecoveryState({ phase: 'case2Choice', userId, queuedOpCount });
}

/** Test-only: clears the shared store between cases. */
export function resetSyncRecoveryStoreForTests(): void {
    state = SYNC_RECOVERY_IDLE;
    listeners.clear();
}
