import type { IDBPDatabase } from 'idb';
import { useEffect, useState } from 'react';
import { getRoutinesByUser } from '../db/routineHelpers';
import type { MyDB, StoredRoutine } from '../types/MyDB';

export function useRoutines(db: IDBPDatabase<MyDB>, userId: string | null): StoredRoutine[] {
    const [routines, setRoutines] = useState<StoredRoutine[]>([]);

    useEffect(() => {
        if (!userId) return;
        getRoutinesByUser(db, userId)
            .then(setRoutines)
            .catch(() => {});
    }, [db, userId]);

    return routines;
}
