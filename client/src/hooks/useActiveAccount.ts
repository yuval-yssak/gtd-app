import type { IDBPDatabase } from 'idb';
import { useEffect, useState } from 'react';
import { getActiveAccount } from '../db/accountHelpers';
import type { MyDB, StoredAccount } from '../types/MyDB';

export function useActiveAccount(db: IDBPDatabase<MyDB>): StoredAccount | null {
    const [account, setAccount] = useState<StoredAccount | null>(null);

    useEffect(() => {
        // getActiveAccount returns undefined (not null) when absent, so map it to null to satisfy StoredAccount | null state
        getActiveAccount(db)
            .then((a) => setAccount(a ?? null))
            .catch(() => {});
    }, [db]);

    return account;
}
