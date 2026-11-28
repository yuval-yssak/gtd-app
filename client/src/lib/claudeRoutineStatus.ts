import dayjs from 'dayjs';

/** `unknown` until a check for that account lands — the box then behaves as before (the ask's error explains). */
export type ClaudeRoutineStatus = 'connected' | 'notConnected' | 'unknown';

/**
 * How long a check stays fresh. A Weekly Review mounts a card per item; without this every card
 * would pivot the session to read the same answer. Settings writes through `remember`, so the
 * TTL only delays a change made on ANOTHER device.
 */
export const CLAUDE_ROUTINE_STATUS_TTL_MS = 5 * 60_000;

/**
 * A check that has not settled by now counts as failed. The read itself has its own 8 s deadline,
 * but the session pivot around it has none — a hung pivot would otherwise stay the shared
 * in-flight check forever, and every later (even forced) refresh would join it.
 */
export const CLAUDE_ROUTINE_CHECK_DEADLINE_MS = 15_000;

interface StatusEntry {
    isConnected: boolean;
    checkedAtMs: number;
}

interface StoreClock {
    nowMs: () => number;
    /** Rejects after the given delay — injected so tests can settle the deadline without timers. */
    deadline: (ms: number) => Promise<never>;
}

const realClock: StoreClock = {
    nowMs: () => dayjs().valueOf(),
    deadline: (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('Claude routine status check timed out')), ms)),
};

/** Whether each account has a Claude routine connected — server-only state, so it lives in memory per page. */
export function createClaudeRoutineStatusStore(clock: StoreClock = realClock) {
    const entries = new Map<string, StatusEntry>();
    const inFlight = new Map<string, Promise<void>>();
    // Bumped by every write, so a check that started before a newer answer cannot overwrite it.
    const generations = new Map<string, number>();
    const listeners = new Set<() => void>();

    function remember(userId: string, isConnected: boolean) {
        generations.set(userId, (generations.get(userId) ?? 0) + 1);
        entries.set(userId, { isConnected, checkedAtMs: clock.nowMs() });
        for (const listener of listeners) {
            listener();
        }
    }

    function isFresh(userId: string) {
        const entry = entries.get(userId);
        return entry !== undefined && clock.nowMs() - entry.checkedAtMs < CLAUDE_ROUTINE_STATUS_TTL_MS;
    }

    async function runCheck(userId: string, checkIsConnected: () => Promise<boolean>) {
        const startedAt = generations.get(userId) ?? 0;
        try {
            const isConnected = await Promise.race([checkIsConnected(), clock.deadline(CLAUDE_ROUTINE_CHECK_DEADLINE_MS)]);
            if ((generations.get(userId) ?? 0) === startedAt) {
                remember(userId, isConnected);
            }
        } catch {
            // Keep the last known answer: a failed read says nothing about the connection.
        } finally {
            inFlight.delete(userId);
        }
    }

    return {
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        statusOf(userId: string): ClaudeRoutineStatus {
            const entry = entries.get(userId);
            if (!entry) return 'unknown';
            return entry.isConnected ? 'connected' : 'notConnected';
        },
        remember,
        /** Checks the account unless a fresh answer exists (or `isForced`); concurrent callers share one check. */
        refresh(userId: string, checkIsConnected: () => Promise<boolean>, { isForced = false }: { isForced?: boolean } = {}) {
            const pending = inFlight.get(userId);
            if (pending) {
                return pending;
            }
            if (!isForced && isFresh(userId)) {
                return Promise.resolve();
            }
            const check = runCheck(userId, checkIsConnected);
            inFlight.set(userId, check);
            return check;
        },
    };
}

export const claudeRoutineStatusStore = createClaudeRoutineStatusStore();
