/**
 * PARITY FIXTURES — the client test (`client/src/tests/routineOccurrenceCount.test.ts`) asserts the
 * identical table against its mirror of `lib/routineOccurrenceCount.ts`. A divergence means the API
 * and the client would disagree on when a COUNT-bounded routine ends. Change both files together.
 */
import { describe, expect, it } from 'vitest';
import { hasUsedAllOccurrences } from '../lib/routineOccurrenceCount.js';

type OccurrenceRow = { _id: string; status: string; expectedBy?: string };

const done = (expectedBy: string, _id = `d-${expectedBy}`): OccurrenceRow => ({ _id, status: 'done', expectedBy });
const trashed = (expectedBy: string, _id = `t-${expectedBy}`): OccurrenceRow => ({ _id, status: 'trash', expectedBy });
const open = (expectedBy: string): OccurrenceRow => ({ _id: `o-${expectedBy}`, status: 'nextAction', expectedBy });

const FIVE_MONTHLY_DONE = ['2026-07-08', '2026-08-08', '2026-09-08', '2026-10-08', '2026-11-08'].map((d) => done(d));

const NEXT_MONTH = '2026-12-08';
const DAY_3 = '2026-01-03';

const USED_ALL_FIXTURE: ReadonlyArray<readonly [label: string, rrule: string, items: OccurrenceRow[], candidateDate: string, expected: boolean]> = [
    ['no COUNT: never used up', 'FREQ=MONTHLY;BYMONTHDAY=8', FIVE_MONTHLY_DONE, NEXT_MONTH, false],
    ['UNTIL-bounded: not decided by consumption', 'FREQ=DAILY;UNTIL=20200101T000000Z', FIVE_MONTHLY_DONE, NEXT_MONTH, false],
    ['COUNT=5 with five done: used up', 'FREQ=MONTHLY;BYMONTHDAY=8;COUNT=5', FIVE_MONTHLY_DONE, NEXT_MONTH, true],
    ['COUNT=5 with four done: one left', 'FREQ=MONTHLY;BYMONTHDAY=8;COUNT=5', FIVE_MONTHLY_DONE.slice(0, 4), NEXT_MONTH, false],
    ['COUNT first in the rule', 'COUNT=5;FREQ=MONTHLY;BYMONTHDAY=8', FIVE_MONTHLY_DONE, NEXT_MONTH, true],
    ['lowercase rule', 'freq=monthly;bymonthday=8;count=5', FIVE_MONTHLY_DONE, NEXT_MONTH, true],
    ['a trashed occurrence is a skipped one and still counts', 'FREQ=DAILY;COUNT=2', [done('2026-01-01'), trashed('2026-01-02')], DAY_3, true],
    ['open items are not consumed', 'FREQ=DAILY;COUNT=2', [done('2026-01-01'), open('2026-01-02')], DAY_3, false],
    ['twins sharing one due date count once', 'FREQ=DAILY;COUNT=2', [done('2026-01-01', 'a'), trashed('2026-01-01', 'b')], DAY_3, false],
    [
        'a done row without a due date (calendar-phase history) counts on its own',
        'FREQ=DAILY;COUNT=2',
        [done('2026-01-01'), { _id: 'x', status: 'done' }],
        DAY_3,
        true,
    ],
    [
        'a trashed row without a due date (type-switch / calendar trash) does not count',
        'FREQ=DAILY;COUNT=2',
        [done('2026-01-01'), { _id: 'c', status: 'trash' }],
        DAY_3,
        false,
    ],
    [
        're-issuing a date trashed by a pause does not charge for it again',
        'FREQ=MONTHLY;BYMONTHDAY=8;COUNT=5',
        [...FIVE_MONTHLY_DONE.slice(0, 4), trashed('2026-11-08')],
        '2026-11-08',
        false,
    ],
    ['a done date that comes up again (completed early) still counts', 'FREQ=DAILY;COUNT=2', [done('2026-01-01'), done('2026-01-02')], '2026-01-02', true],
    [
        'a date skipped early comes up again and is not charged (accepted: skips never end a series early)',
        'FREQ=DAILY;COUNT=2',
        [done('2026-01-01'), trashed('2026-01-02')],
        '2026-01-02',
        false,
    ],
    ['COUNT=1 with nothing consumed yet', 'FREQ=DAILY;COUNT=1', [], '2026-01-01', false],
];

describe('hasUsedAllOccurrences', () => {
    it.each(USED_ALL_FIXTURE)('%s', (_label, rrule, items, candidateDate, expected) => {
        expect(hasUsedAllOccurrences(rrule, items, candidateDate)).toBe(expected);
    });
});
