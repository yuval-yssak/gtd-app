/** Tests for `summarizeRepair` — the human-readable one-liner shown under the "Repair sync" button
 * in Settings after the server's stranded-marker relink sweep completes. */
import { describe, expect, it } from 'vitest';
import type { RelinkSweepCounts } from '../api/calendarApi';
import { summarizeRepair } from '../components/settings/CalendarIntegrations';

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
