import type { IDBPDatabase } from 'idb';
import { Suspense } from 'react';
import { useItemFreshness } from '../hooks/useItemFreshness';
import type { MyDB, StoredItem } from '../types/MyDB';
import { FreshnessBadge } from './FreshnessBadge';

function ItemFreshness({ db, item }: { db: IDBPDatabase<MyDB>; item: StoredItem }) {
    return <FreshnessBadge freshness={useItemFreshness(db, item)} />;
}

/** The item's freshness badge, with its own boundary so the one-off queue read never suspends the page. */
export function ItemFreshnessBadge({ db, item }: { db: IDBPDatabase<MyDB>; item: StoredItem }) {
    return (
        <Suspense fallback={null}>
            <ItemFreshness db={db} item={item} />
        </Suspense>
    );
}
