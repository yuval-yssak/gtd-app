import type { StoredRoutine } from '../types/MyDB';
import { evenlySpacedRanks, isRankTooLong, isStrictlyIncreasing, rankBetween } from './itemRank';

/** A move within one frequency group: the routine and the (visible) neighbours it lands between. */
export interface RoutineMove {
    routineId: string;
    aboveId: string | undefined;
    belowId: string | undefined;
}

export interface PlannedRoutineRank {
    routineId: string;
    rank: string;
}

/**
 * The rank writes for a /routines reorder. `group` is the WHOLE frequency group in display order
 * (hidden-by-search routines included, so they keep their place). In a fully ranked group only the
 * moved routine is re-keyed between its new neighbours; a group with unranked routines (never
 * reordered, or a newcomer) — or a key grown too long — is keyed whole in its new order, so nothing
 * but the moved routine changes place. Empty when nothing moves.
 */
export function planRoutineReorder(group: readonly StoredRoutine[], move: RoutineMove): PlannedRoutineRank[] {
    const moved = group.find((routine) => routine._id === move.routineId);
    if (!moved) {
        return [];
    }
    const others = group.filter((routine) => routine !== moved);
    const order = insertAtMove(others, moved, move);
    if (order.every((routine, index) => routine === group[index])) {
        return [];
    }
    return isFullyRanked(others) ? rekeyMoved(order, moved) : rekeyAll(order);
}

/** `moved` placed right below `above` — or right above `below` when it goes to the top. */
function insertAtMove(others: readonly StoredRoutine[], moved: StoredRoutine, move: RoutineMove) {
    const aboveIndex = others.findIndex((routine) => routine._id === move.aboveId);
    const belowIndex = others.findIndex((routine) => routine._id === move.belowId);
    const slot = aboveIndex >= 0 ? aboveIndex + 1 : belowIndex >= 0 ? belowIndex : others.length;
    return [...others.slice(0, slot), moved, ...others.slice(slot)];
}

function isFullyRanked(routines: readonly StoredRoutine[]) {
    const ranks = routines.map((routine) => routine.rank);
    return ranks.every((rank) => rank !== undefined) && isStrictlyIncreasing(ranks.filter((rank) => rank !== undefined));
}

function rekeyMoved(order: readonly StoredRoutine[], moved: StoredRoutine): PlannedRoutineRank[] {
    const index = order.indexOf(moved);
    const rank = rankBetween(order[index - 1]?.rank, order[index + 1]?.rank);
    return isRankTooLong(rank) ? rekeyAll(order) : [{ routineId: moved._id, rank }];
}

/** Fresh evenly spaced keys for the whole group; only routines whose key changes are written. */
function rekeyAll(order: readonly StoredRoutine[]): PlannedRoutineRank[] {
    const ranks = evenlySpacedRanks(order.length);
    return order.flatMap((routine, index) => {
        const rank = ranks[index];
        return rank !== undefined && rank !== routine.rank ? [{ routineId: routine._id, rank }] : [];
    });
}
