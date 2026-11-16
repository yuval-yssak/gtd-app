import type { IDBPDatabase } from 'idb';
import { Suspense } from 'react';
import { type OwnedEntityRef, useEntityFreshness } from '../hooks/useEntityFreshness';
import type { MyDB } from '../types/MyDB';
import { FreshnessBadge } from './FreshnessBadge';

interface EntityFreshnessBadgeProps {
    db: IDBPDatabase<MyDB>;
    entity: OwnedEntityRef;
}

function EntityFreshness({ db, entity }: EntityFreshnessBadgeProps) {
    return <FreshnessBadge freshness={useEntityFreshness(db, entity)} />;
}

/** A detail page's freshness badge, with its own boundary so the one-off queue read never suspends the page. */
export function EntityFreshnessBadge({ db, entity }: EntityFreshnessBadgeProps) {
    return (
        <Suspense fallback={null}>
            <EntityFreshness db={db} entity={entity} />
        </Suspense>
    );
}
