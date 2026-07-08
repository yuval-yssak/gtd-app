/** Tests for the "Repair sync" composition: `sweepAllAccounts` (per-account fan-out under owner
 * sessions — the layer where the wrong-account field bug lived), `addRepairCounts`, and
 * `summarizeRepair` (the human-readable one-liner shown under the button). */
import { describe, expect, it, vi } from 'vitest';
import type { RelinkSweepCounts } from '../api/calendarApi';
import { addRepairCounts, summarizeRepair, sweepAllAccounts, zeroRepairCounts } from '../components/settings/CalendarIntegrations';

const zeroCounts: RelinkSweepCounts = {
    relinkedItems: 0,
    relinkedRoutines: 0,
    recreatedEvents: 0,
    trashedItems: 0,
    deactivatedRoutines: 0,
    clearedMarkers: 0,
};

describe('summarizeRepair', () => {
    it('reads as a no-op when every count is zero', () => {
        expect(summarizeRepair(zeroCounts)).toBe('Everything is already linked — nothing needed repair.');
    });

    it('lists only the non-zero categories, comma-separated', () => {
        const summary = summarizeRepair({ ...zeroCounts, relinkedItems: 2, recreatedEvents: 1 });
        expect(summary).toBe('Repaired: 2 items relinked, 1 event recreated on Google.');
    });

    it('pluralizes correctly at exactly one', () => {
        const summary = summarizeRepair({ ...zeroCounts, relinkedItems: 1, relinkedRoutines: 1 });
        expect(summary).toBe('Repaired: 1 item relinked, 1 routine relinked.');
    });

    it('covers the trash / pause / cleared categories', () => {
        const summary = summarizeRepair({ ...zeroCounts, trashedItems: 3, deactivatedRoutines: 1, clearedMarkers: 2 });
        expect(summary).toBe('Repaired: 3 cancelled items trashed, 1 ended routine paused, 2 stale links cleared.');
    });
});

describe('sweepAllAccounts', () => {
    it('runs one sweep per logged-in account, each pinned to that account, and returns the summed counts', async () => {
        const pinnedRuns: string[] = [];
        const perAccount: Record<string, RelinkSweepCounts> = {
            'user-personal': { ...zeroRepairCounts(), relinkedItems: 11, relinkedRoutines: 2 },
            'user-work': { ...zeroRepairCounts(), clearedMarkers: 1 },
        };
        let pinnedTo: string | null = null;
        const withOwnerSession = async <T>(userId: string, task: () => Promise<T>): Promise<T> => {
            pinnedTo = userId;
            try {
                return await task();
            } finally {
                pinnedTo = null;
            }
        };
        const runSweep = vi.fn(async () => {
            if (!pinnedTo) throw new Error('sweep ran without an owner session pinned');
            pinnedRuns.push(pinnedTo);
            const counts = perAccount[pinnedTo];
            if (!counts) throw new Error(`unexpected pinned account ${pinnedTo}`);
            return counts;
        });

        const totals = await sweepAllAccounts(['user-personal', 'user-work'], withOwnerSession, runSweep);

        expect(runSweep).toHaveBeenCalledTimes(2);
        expect(pinnedRuns).toEqual(['user-personal', 'user-work']);
        expect(totals).toEqual({ ...zeroRepairCounts(), relinkedItems: 11, relinkedRoutines: 2, clearedMarkers: 1 });
    });

    it('never overlaps two owner-session pins — the second sweep starts only after the first finishes', async () => {
        // The shared Better Auth active session makes concurrent pins racy; pin the sequential
        // guarantee by failing loudly if a second session opens while one is still active.
        let activePins = 0;
        const withOwnerSession = async <T>(_userId: string, task: () => Promise<T>): Promise<T> => {
            if (activePins > 0) throw new Error('overlapping owner-session pins');
            activePins += 1;
            // Yield to the microtask queue so an eagerly-started second pin would be observed.
            await Promise.resolve();
            try {
                return await task();
            } finally {
                activePins -= 1;
            }
        };
        const runSweep = vi.fn(async () => zeroRepairCounts());

        await expect(sweepAllAccounts(['a', 'b', 'c'], withOwnerSession, runSweep)).resolves.toEqual(zeroRepairCounts());
        expect(runSweep).toHaveBeenCalledTimes(3);
    });

    it('falls back to a single ambient sweep when no accounts are tracked', async () => {
        // Plain function with a counter — vi.fn cannot wrap a generic signature without erasing T.
        let ownerSessionCalls = 0;
        const withOwnerSession = async <T>(_userId: string, task: () => Promise<T>): Promise<T> => {
            ownerSessionCalls += 1;
            return task();
        };
        const ambient = { ...zeroRepairCounts(), recreatedEvents: 2 };
        const runSweep = vi.fn(async () => ambient);

        const totals = await sweepAllAccounts([], withOwnerSession, runSweep);

        expect(ownerSessionCalls).toBe(0);
        expect(runSweep).toHaveBeenCalledTimes(1);
        expect(totals).toEqual(ambient);
    });
});

describe('addRepairCounts', () => {
    it('sums every field so multi-account sweeps report one total', () => {
        const a: RelinkSweepCounts = { ...zeroCounts, relinkedItems: 2, trashedItems: 1 };
        const b: RelinkSweepCounts = { ...zeroCounts, relinkedItems: 1, relinkedRoutines: 3, clearedMarkers: 4 };
        expect(addRepairCounts(a, b)).toEqual({
            relinkedItems: 3,
            relinkedRoutines: 3,
            recreatedEvents: 0,
            trashedItems: 1,
            deactivatedRoutines: 0,
            clearedMarkers: 4,
        });
    });
});
