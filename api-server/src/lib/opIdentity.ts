import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';

/**
 * Millisecond of the most recently issued identity. Together with `sameMsSeq` this makes the
 * allocator monotonic within the process even if the wall clock steps backwards (NTP correction):
 * `ts` never decreases and `id` strictly increases across calls.
 */
let lastIssuedMs = 0;
let sameMsSeq = 0;

/** Fixed digit widths keep lexicographic string order identical to numeric order. */
const MS_DIGITS = 14;
const SEQ_DIGITS = 6;
/**
 * Highest sequence that still fits SEQ_DIGITS. `padStart` does NOT truncate, and a 7-digit
 * sequence would sort lexicographically BELOW '999999' — breaking the strict-increase contract —
 * so on exhaustion the allocator borrows the next millisecond instead of widening the field.
 */
const MAX_SEQ = 10 ** SEQ_DIGITS - 1;

export interface OpIdentity {
    /** ISO datetime for `Operation.ts` — allocated from the wall clock at call time. */
    ts: string;
    /** Sortable `Operation._id`: fixed-width epoch-ms + per-ms sequence + UUID suffix for cross-instance uniqueness. */
    id: string;
}

/**
 * Allocates the `(ts, _id)` identity for one operation, AT WRITE TIME.
 *
 * Why this exists: `/sync/pull` pages over the totally-ordered `(ts, _id)` pair with a strictly
 * forward cursor, so an op inserted with a `ts` older than ops a device has already pulled is
 * permanently invisible to that device. Server sync runs used to stamp `ts` from a clock captured
 * at run start — minutes before the insert on a slow GCal sweep — which is exactly that failure
 * (the "organizer moved a meeting but IndexedDB never updated" bug). Allocating at write time
 * bounds the ts-to-commit gap to the insert itself, which the pull-side cursor holdback covers.
 *
 * The per-ms sequence in the `_id` also makes same-millisecond ops sort in allocation order
 * instead of random-UUID order, so devices replaying the log converge on the same final state the
 * server reached (the same-ms double-write tie-order defect). Monotonicity is per-process; the
 * UUID suffix keeps ids collision-free across instances. DEPLOYMENT ASSUMPTION: cross-instance
 * clock skew is absorbed only up to the pull-side CURSOR_HOLDBACK_SECONDS window — an instance
 * whose clock runs further behind its peers than that can still write skippable ops.
 *
 * Invariant consumers rely on: an op's `_id` ms-prefix agrees with its `ts`, so an op's position
 * in the `(ts, _id)` order can never be moved by rewriting `ts` alone — republish under a fresh
 * identity instead (see the /sync/issues retry route).
 */
export function allocateOpIdentity(): OpIdentity {
    const wallMs = dayjs().valueOf();
    if (wallMs > lastIssuedMs) {
        lastIssuedMs = wallMs;
        sameMsSeq = 0;
    } else if (sameMsSeq >= MAX_SEQ) {
        // Sequence exhausted for this ms (reachable during a long clock regression, when every
        // call lands on the pinned `lastIssuedMs`) — borrow the next ms and restart the sequence.
        lastIssuedMs += 1;
        sameMsSeq = 0;
    } else {
        sameMsSeq += 1;
    }
    const msPart = String(lastIssuedMs).padStart(MS_DIGITS, '0');
    const seqPart = String(sameMsSeq).padStart(SEQ_DIGITS, '0');
    return { ts: dayjs(lastIssuedMs).toISOString(), id: `${msPart}-${seqPart}-${randomUUID()}` };
}
