import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';

/**
 * A per-call unique token for test emails and seeded ids. A bare millisecond timestamp collides when two copies
 * of one test start in the same millisecond (`--repeat-each` across workers): both then log in as
 * ONE user and see each other's seeded data. Timestamp first, so emails still sort by creation.
 */
export function uniqueStamp(): string {
    return `${dayjs().valueOf()}-${randomUUID().slice(0, 8)}`;
}
