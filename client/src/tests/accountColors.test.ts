import { describe, expect, it } from 'vitest';
import { ACCOUNT_COLOR_PALETTE, getAccountColor } from '../lib/accountColors';
import type { StoredAccount } from '../types/MyDB';

function makeAccount(id: string, addedAt: number): StoredAccount {
    return {
        id,
        email: `${id}@example.com`,
        name: id,
        image: null,
        provider: 'google',
        addedAt,
    };
}

describe('getAccountColor', () => {
    it('assigns the first palette colour to the oldest-added account', () => {
        const accounts = [makeAccount('u3', 3000), makeAccount('u1', 1000), makeAccount('u2', 2000)];
        // Expect order by addedAt: u1, u2, u3 → colours 0, 1, 2.
        expect(getAccountColor('u1', accounts)).toBe(ACCOUNT_COLOR_PALETTE[0]);
        expect(getAccountColor('u2', accounts)).toBe(ACCOUNT_COLOR_PALETTE[1]);
        expect(getAccountColor('u3', accounts)).toBe(ACCOUNT_COLOR_PALETTE[2]);
    });

    it('produces stable assignments regardless of caller-supplied order', () => {
        const ascending = [makeAccount('u1', 1000), makeAccount('u2', 2000)];
        const descending = [makeAccount('u2', 2000), makeAccount('u1', 1000)];
        expect(getAccountColor('u1', ascending)).toBe(getAccountColor('u1', descending));
        expect(getAccountColor('u2', ascending)).toBe(getAccountColor('u2', descending));
    });

    it('returns the first palette colour for a userId not present in allAccounts', () => {
        const accounts = [makeAccount('u1', 1000)];
        expect(getAccountColor('ghost', accounts)).toBe(ACCOUNT_COLOR_PALETTE[0]);
    });

    it('wraps the palette modulo when more accounts than colours exist', () => {
        const accounts = Array.from({ length: ACCOUNT_COLOR_PALETTE.length + 2 }, (_, i) => makeAccount(`u${i}`, i + 1));
        // The (palette.length)-th account wraps back to colour 0.
        expect(getAccountColor(`u${ACCOUNT_COLOR_PALETTE.length}`, accounts)).toBe(ACCOUNT_COLOR_PALETTE[0]);
        expect(getAccountColor(`u${ACCOUNT_COLOR_PALETTE.length + 1}`, accounts)).toBe(ACCOUNT_COLOR_PALETTE[1]);
    });
});
