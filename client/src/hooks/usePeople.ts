import type { IDBPDatabase } from 'idb';
import { useEffect, useState } from 'react';
import { getPeopleByUser } from '../db/personHelpers';
import type { MyDB, StoredPerson } from '../types/MyDB';

export function usePeople(db: IDBPDatabase<MyDB>, userId: string | null): StoredPerson[] {
    const [people, setPeople] = useState<StoredPerson[]>([]);

    useEffect(() => {
        if (!userId) return;
        getPeopleByUser(db, userId)
            .then(setPeople)
            .catch(() => {});
    }, [db, userId]);

    return people;
}
