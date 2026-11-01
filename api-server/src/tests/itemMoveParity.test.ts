/**
 * PARITY FIXTURES — the client test (`client/src/tests/itemMoveParity.test.ts`) asserts the identical
 * tables against the app's `compareByRank` (`lib/compareNextActions.ts`) and `nonIncreasingRun`
 * (`db/itemMutations.ts`), the originals `lib/itemMove.ts` ports. A divergence means an order the
 * API writes would display differently in the app. Change both files together.
 */
import { describe, expect, it } from 'vitest';
import { compareByRank, nonIncreasingRun, type RankedRow } from '../lib/itemMove.js';

type FixtureRow = readonly [id: string, rank: string | null, createdTs: string];

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-02T00:00:00.000Z';

/** Rows in arbitrary order → ids in display order (`compareByRank`). */
const SORT_FIXTURE: ReadonlyArray<readonly [rows: readonly FixtureRow[], expected: readonly string[]]> = [
    [
        [
            ['b', 'a1', T1],
            ['a', 'a0', T1],
        ],
        ['a', 'b'],
    ],
    [
        [
            ['r', 'a0', T1],
            ['u', null, T1],
        ],
        ['u', 'r'],
    ],
    [
        [
            ['old', null, T1],
            ['new', null, T2],
        ],
        ['new', 'old'],
    ],
    [
        [
            ['z', 'a0', T1],
            ['y', 'a0', T1],
        ],
        ['y', 'z'],
    ],
    [
        [
            ['lower', 'a0', T1],
            ['upper', 'B0', T1],
        ],
        ['upper', 'lower'],
    ],
    [
        [
            ['s', null, T1],
            ['r', null, T1],
        ],
        ['r', 's'],
    ],
];

/** Rows in display order + the [from, to] slot window → the run to re-key (`nonIncreasingRun`). */
const RUN_FIXTURE: ReadonlyArray<readonly [rows: readonly FixtureRow[], from: number, to: number, expected: { lo: number; hi: number }]> = [
    [
        [
            ['a', 'a0', T1],
            ['b', 'a1', T1],
            ['c', 'a2', T1],
        ],
        0,
        1,
        { lo: 0, hi: 0 },
    ],
    [
        [
            ['u1', null, T2],
            ['u2', null, T1],
            ['a', 'a0', T1],
        ],
        0,
        1,
        { lo: 0, hi: 1 },
    ],
    [
        [
            ['u1', null, T2],
            ['u2', null, T1],
            ['a', 'a0', T1],
            ['b', 'a1', T1],
        ],
        1,
        2,
        { lo: 0, hi: 1 },
    ],
    [
        [
            ['a', 'a0', T1],
            ['b', 'a0', T1],
            ['c', 'a1', T1],
        ],
        0,
        1,
        { lo: 0, hi: 0 },
    ],
    [
        [
            ['a', 'a0', T1],
            ['b', 'a0', T1],
            ['c', 'a0', T1],
            ['d', 'a2', T1],
        ],
        1,
        2,
        { lo: 0, hi: 1 },
    ],
    [
        [
            ['u', null, T1],
            ['a', 'a0', T1],
            ['b', 'a0', T1],
        ],
        0,
        0,
        { lo: 0, hi: 1 },
    ],
    // Lower edge trims forward: the upper edge is stuck on equal keys, p's old key already fits below r.
    [
        [
            ['x', 'a0', T1],
            ['p', 'a1', T1],
            ['q', 'a2', T1],
            ['r', 'a2', T1],
        ],
        1,
        2,
        { lo: 2, hi: 2 },
    ],
    // from > to; growth over equal keys stops above 0; the upper-edge trim runs with lo > 0.
    [
        [
            ['a', 'a0', T1],
            ['b', 'a1', T1],
            ['c', 'a1', T1],
            ['d', 'a2', T1],
            ['e', 'a3', T1],
        ],
        3,
        2,
        { lo: 1, hi: 1 },
    ],
    // `to` past the end is clamped to the last row.
    [
        [
            ['a', 'a0', T1],
            ['b', 'a1', T1],
        ],
        1,
        5,
        { lo: 1, hi: 1 },
    ],
];

function toRow([id, rank, createdTs]: FixtureRow): RankedRow {
    return { _id: id, createdTs, ...(rank !== null ? { rank } : {}) };
}

describe('item move parity (api-server itemMove.ts ↔ client)', () => {
    it.each(SORT_FIXTURE)('compareByRank orders %j as %j', (rows, expected) => {
        expect(
            rows
                .map(toRow)
                .sort(compareByRank)
                .map((row) => row._id),
        ).toEqual(expected);
    });

    it.each(RUN_FIXTURE)('nonIncreasingRun over %j from %i to %i is %j', (rows, from, to, expected) => {
        expect(nonIncreasingRun(rows.map(toRow), from, to)).toEqual(expected);
    });
});
