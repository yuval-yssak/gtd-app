import { describe, expect, it } from 'vitest';
import { cutToLimit, nextPullCursor, PULL_PAGE_MAX, parsePullLimit, shouldCarryRestOfWindow } from '../lib/pullPaging.js';

describe('parsePullLimit', () => {
    it('is unbounded when the client sends no limit (old clients)', () => {
        expect(parsePullLimit(undefined)).toEqual({ ok: true, limit: undefined });
    });

    it('accepts a positive integer', () => {
        expect(parsePullLimit('50')).toEqual({ ok: true, limit: 50 });
    });

    it('caps an oversized limit at the server maximum', () => {
        expect(parsePullLimit(String(PULL_PAGE_MAX + 1))).toEqual({ ok: true, limit: PULL_PAGE_MAX });
    });

    it.each(['0', '-1', '2.5', 'abc', '', '1e2', '0x10', ' 5 ', '05'])('rejects %j', (raw) => {
        expect(parsePullLimit(raw).ok).toBe(false);
    });
});

describe('nextPullCursor', () => {
    const incoming = { ts: '2025-01-01T00:00:00.000Z', id: '' };
    const holdback = { ts: '2025-06-01T00:00:00.000Z', id: '' };
    const settled = { ts: '2025-03-01T00:00:00.000Z', id: 'op-1' };
    const fresh = { ts: '2025-06-01T00:00:01.000Z', id: 'op-2' };

    it('a page with more behind it points at its last op', () => {
        expect(nextPullCursor({ lastOp: settled, hasMoreOps: true, holdback, incoming })).toEqual({ cursor: settled, hasMore: true });
    });

    it('the final page points at its last op', () => {
        expect(nextPullCursor({ lastOp: settled, hasMoreOps: false, holdback, incoming })).toEqual({ cursor: settled, hasMore: false });
    });

    it('a page reaching into the holdback window is held back and ends paging, even with more ops behind it', () => {
        expect(nextPullCursor({ lastOp: fresh, hasMoreOps: true, holdback, incoming })).toEqual({ cursor: holdback, hasMore: false });
    });

    it('an empty pull advances to the holdback boundary', () => {
        expect(nextPullCursor({ lastOp: undefined, hasMoreOps: false, holdback, incoming })).toEqual({ cursor: holdback, hasMore: false });
    });

    it('never points below the incoming cursor, and ends paging when it cannot advance', () => {
        // A client already past the held-back boundary (legacy wall-clock cursor, clock skew).
        const betweenHoldbackAndLastOp = { ts: '2025-06-01T00:00:00.500Z', id: 'x' };
        expect(nextPullCursor({ lastOp: fresh, hasMoreOps: true, holdback, incoming: betweenHoldbackAndLastOp })).toEqual({
            cursor: betweenHoldbackAndLastOp,
            hasMore: false,
        });
    });
});

describe('cutToLimit', () => {
    const op = (id: string) => ({ ts: `2025-01-01T00:00:00.00${id}Z`, _id: id });

    it('keeps everything and reports nothing more when there is no limit', () => {
        expect(cutToLimit([op('1'), op('2')], undefined)).toEqual({ ops: [op('1'), op('2')], hasMoreOps: false, lastOp: { ts: op('2').ts, id: '2' } });
    });

    it('drops the extra row read past the limit and reports more', () => {
        expect(cutToLimit([op('1'), op('2'), op('3')], 2)).toEqual({ ops: [op('1'), op('2')], hasMoreOps: true, lastOp: { ts: op('2').ts, id: '2' } });
    });

    it('reports nothing more when the read came back short', () => {
        expect(cutToLimit([op('1')], 2)).toEqual({ ops: [op('1')], hasMoreOps: false, lastOp: { ts: op('1').ts, id: '1' } });
    });

    it('has no last op for an empty page', () => {
        expect(cutToLimit([], 2)).toEqual({ ops: [], hasMoreOps: false, lastOp: undefined });
    });
});

describe('shouldCarryRestOfWindow', () => {
    const holdback = { ts: '2025-06-01T00:00:00.000Z', id: '' };

    it('is true for a cut-off page whose last op is inside the holdback window', () => {
        expect(shouldCarryRestOfWindow({ hasMoreOps: true, lastOp: { ts: '2025-06-01T00:00:01.000Z', id: 'f' } }, holdback)).toBe(true);
    });

    it('is false for a cut-off page of settled ops — it just pages on', () => {
        expect(shouldCarryRestOfWindow({ hasMoreOps: true, lastOp: { ts: '2025-05-01T00:00:00.000Z', id: 's' } }, holdback)).toBe(false);
    });

    it('is false for a final page — nothing was cut off', () => {
        expect(shouldCarryRestOfWindow({ hasMoreOps: false, lastOp: { ts: '2025-06-01T00:00:01.000Z', id: 'f' } }, holdback)).toBe(false);
    });
});
