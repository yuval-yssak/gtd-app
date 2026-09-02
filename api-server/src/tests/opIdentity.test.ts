import dayjs from 'dayjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allocateOpIdentity } from '../lib/opIdentity.js';
import { MAX_OP_ID } from '../types/entities.js';

afterEach(() => {
    vi.useRealTimers();
});

describe('allocateOpIdentity', () => {
    it('issues strictly increasing ids and non-decreasing ts across rapid calls', () => {
        const identities = Array.from({ length: 500 }, () => allocateOpIdentity());
        for (let i = 1; i < identities.length; i++) {
            const [prev, cur] = [identities[i - 1], identities[i]];
            if (!prev || !cur) {
                throw new Error('expected allocated identities');
            }
            expect(cur.id > prev.id).toBe(true);
            expect(cur.ts >= prev.ts).toBe(true);
        }
    });

    it('every id ms-prefix agrees with its ts (the never-rewrite-ts-alone invariant)', () => {
        // Consumers (e.g. the /sync/issues retry route) rely on the id encoding the same ms as the
        // ts — rewriting `ts` without a fresh id would leave the op sorted at its old position.
        const { ts, id } = allocateOpIdentity();
        expect(id.startsWith(String(dayjs(ts).valueOf()).padStart(14, '0'))).toBe(true);
    });

    it('ts is the wall clock at allocation time', () => {
        const before = dayjs().toISOString();
        const { ts } = allocateOpIdentity();
        const after = dayjs().toISOString();
        expect(ts >= before).toBe(true);
        expect(ts <= after).toBe(true);
    });

    it('same-millisecond allocations share ts but order by the sequence component', () => {
        vi.useFakeTimers();
        vi.setSystemTime(dayjs('2026-08-31T12:00:00.123Z').toDate());
        const a = allocateOpIdentity();
        const b = allocateOpIdentity();
        expect(a.ts >= '2026-08-31T12:00:00.123Z').toBe(true);
        expect(b.ts).toBe(a.ts);
        expect(b.id > a.id).toBe(true);
    });

    it('stays monotonic when the wall clock steps backwards', () => {
        vi.useFakeTimers();
        vi.setSystemTime(dayjs('2026-08-31T12:00:10.000Z').toDate());
        const before = allocateOpIdentity();
        vi.setSystemTime(dayjs('2026-08-31T12:00:05.000Z').toDate()); // NTP-style regression
        const after = allocateOpIdentity();
        expect(after.ts >= before.ts).toBe(true);
        expect(after.id > before.id).toBe(true);
        // The id must track the (pinned) ts, not the regressed wall clock.
        expect(after.id.startsWith(String(dayjs(after.ts).valueOf()).padStart(14, '0'))).toBe(true);
    });

    it('borrows the next millisecond when the per-ms sequence is exhausted (ids stay strictly increasing)', () => {
        // Reachable during a long clock regression: every call lands on the pinned ms and burns a
        // sequence slot. Without the borrow, the 7-digit '1000000' would sort BELOW '999999'.
        vi.useFakeTimers();
        vi.setSystemTime(dayjs('2026-08-31T12:00:00.000Z').toDate());
        const total = 10 ** 6 + 2; // one full sequence range plus the borrow
        const identities = Array.from({ length: total }, () => allocateOpIdentity());
        for (let i = 1; i < identities.length; i++) {
            const [prev, cur] = [identities[i - 1], identities[i]];
            if (!prev || !cur) {
                throw new Error('expected allocated identities');
            }
            if (!(cur.id > prev.id)) {
                throw new Error(`id order violated at ${i}: ${prev.id} !< ${cur.id}`);
            }
        }
        const [first] = identities;
        const last = identities.at(-1);
        if (!first || !last) {
            throw new Error('expected allocated identities');
        }
        // The overflow rolled into a later millisecond, and ts followed the borrowed ms.
        expect(last.ts > first.ts).toBe(true);
        expect(last.id.startsWith(String(dayjs(last.ts).valueOf()).padStart(14, '0'))).toBe(true);
    });

    it('ids sort below the legacy MAX_OP_ID bootstrap sentinel', () => {
        // Pre-holdback deviceSyncState rows still carry MAX_OP_ID as lastSyncedId; new op ids must
        // keep sorting below it or those rows' compound floors would mis-order against real ops.
        const { id } = allocateOpIdentity();
        expect(id < MAX_OP_ID).toBe(true);
    });
});
