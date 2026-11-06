import type { IDBPDatabase } from 'idb';
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { reorderRoutine } from '../db/routineMutations';
import { flatSection } from '../lib/nextActionSections';
import type { RoutineBucketGroup } from '../lib/routineGrouping';
import type { MyDB, StoredRoutine } from '../types/MyDB';
import { type RankedRowReorder, useRankedRows } from './useRankedList';

interface UseRankedRoutinesOptions {
    db: IDBPDatabase<MyDB>;
    /** The frequency groups on screen (search-filtered), in display order. */
    visibleGroups: readonly RoutineBucketGroup[];
    /** The same tab's groups unfiltered — a move re-keys a whole group, hidden routines keeping their place. */
    allGroups: readonly RoutineBucketGroup[];
    refreshRoutines: () => Promise<void>;
}

/** Routines never fade out of the list as ghosts — a removal re-renders without them. */
const isNeverGhost = () => false;

/** The /routines manual order: each frequency group is one ranked section (drag, keyboard, "Move to…"). */
export function useRankedRoutines({ db, visibleGroups, allGroups, refreshRoutines }: UseRankedRoutinesOptions) {
    const sections = useMemo(() => visibleGroups.map((group) => flatSection(group.bucket, group.bucket, group.routines)), [visibleGroups]);
    // Read through a ref: a reorder queued behind the previous one runs with the closure of the
    // key press, before that move re-rendered. (reorderRoutine re-reads the rows themselves.)
    const allGroupsRef = useRef(allGroups);
    useLayoutEffect(() => {
        allGroupsRef.current = allGroups;
    }, [allGroups]);
    const reorder = useCallback(
        async ({ itemId, aboveId, belowId }: RankedRowReorder<StoredRoutine>) => {
            const group = allGroupsRef.current.find((candidate) => candidate.routines.some((routine) => routine._id === itemId));
            if (!group) {
                return false;
            }
            const moved = await reorderRoutine(db, group.routines, { routineId: itemId, aboveId, belowId });
            if (moved) {
                await refreshRoutines();
            }
            return moved;
        },
        [db, refreshRoutines],
    );
    return useRankedRows({ sections, isGhost: isNeverGhost, reorder, regionLabel: 'Routines' });
}
