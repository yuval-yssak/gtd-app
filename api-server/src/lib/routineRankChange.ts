import { isDeepStrictEqual } from 'node:util';
import type { RoutineInterface } from '../types/entities.js';

/** The routine minus the fields a /routines reorder writes. */
function withoutReorderFields({ rank: _rank, updatedTs: _updatedTs, ...rest }: RoutineInterface) {
    return rest;
}

/**
 * True when `next` differs from `prior` ONLY by a new `rank` (plus the `updatedTs` every write
 * stamps) — a reorder on the /routines page, which Google Calendar never sees. Key order is
 * ignored: the two snapshots come from different writers.
 */
export function isRankOnlyRoutineChange(prior: RoutineInterface, next: RoutineInterface): boolean {
    return prior.rank !== next.rank && isDeepStrictEqual(withoutReorderFields(prior), withoutReorderFields(next));
}
