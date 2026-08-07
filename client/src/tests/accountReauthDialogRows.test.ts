import { describe, expect, it } from 'vitest';
import { staleAccountRows } from '../components/AccountReauthDialog';

// `staleAccountRows` is the shared dialog/banner mapping from flagged userIds to display rows.
// The load-race edge matters: `useAccounts` populates its account list asynchronously, so a
// flagged id with no matching account must still produce a row (email: null → generic label in
// each surface) instead of being silently dropped — dropping it would hide the broken-sync
// warning entirely, which is the exact failure the dialog exists to prevent.

describe('staleAccountRows', () => {
    it('resolves emails for locally-known accounts', () => {
        const rows = staleAccountRows(['user-a'], [{ id: 'user-a', email: 'a@example.com' }]);
        expect(rows).toEqual([{ id: 'user-a', email: 'a@example.com' }]);
    });

    it('keeps a flagged id with no known account as a row with a null email', () => {
        const rows = staleAccountRows(['user-a', 'user-b'], [{ id: 'user-a', email: 'a@example.com' }]);
        expect(rows).toEqual([
            { id: 'user-a', email: 'a@example.com' },
            { id: 'user-b', email: null },
        ]);
    });

    it('returns every flagged id even when no accounts have loaded yet', () => {
        const rows = staleAccountRows(['user-a'], []);
        expect(rows).toEqual([{ id: 'user-a', email: null }]);
    });

    it('returns no rows when nothing is flagged, regardless of known accounts', () => {
        expect(staleAccountRows([], [{ id: 'user-a', email: 'a@example.com' }])).toEqual([]);
    });
});
