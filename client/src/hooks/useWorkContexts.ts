import type { IDBPDatabase } from 'idb';
import { useEffect, useState } from 'react';
import { getWorkContextsByUser } from '../db/workContextHelpers';
import type { MyDB, StoredWorkContext } from '../types/MyDB';

export function useWorkContexts(db: IDBPDatabase<MyDB>, userId: string | null): StoredWorkContext[] {
    const [workContexts, setWorkContexts] = useState<StoredWorkContext[]>([]);

    useEffect(() => {
        if (!userId) return;
        getWorkContextsByUser(db, userId)
            .then(setWorkContexts)
            .catch(() => {});
    }, [db, userId]);

    return workContexts;
}
