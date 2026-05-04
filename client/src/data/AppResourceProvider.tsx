import type { IDBPDatabase } from 'idb';
import { createContext, type PropsWithChildren, startTransition, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { MyDB } from '../types/MyDB';
import { type AppResourceSnapshot, getAppResource, invalidateAppResource, type ResourceScope } from './appResource';

interface AppResourceContextValue {
    snapshot: AppResourceSnapshot;
    /** Drops cache for the given scope and swaps in the new snapshot inside startTransition. */
    refresh: (scope?: ResourceScope) => void;
}

// biome-ignore lint/style/noNonNullAssertion: provider always wraps consumers; reading outside throws clearly.
const AppResourceContext = createContext<AppResourceContextValue>(undefined!);

export function useAppResource(): AppResourceContextValue {
    return useContext(AppResourceContext);
}

interface Props {
    db: IDBPDatabase<MyDB>;
    /** Stable list of every signed-in account's userId. Snapshot rebuilds when this set changes. */
    userIds: readonly string[];
}

/**
 * Owns the current AppResourceSnapshot. Until consumers `use()` its fields nothing actually
 * suspends — the snapshot is just promises that resolve in the background. `refresh()` swaps in a
 * new snapshot inside `startTransition` so existing UI keeps rendering until the new data is ready.
 */
export function AppResourceProvider({ db, userIds, children }: PropsWithChildren<Props>) {
    // Snapshot identity must change exactly when (db, userIds) change. We re-derive on each render
    // — `getAppResource` returns the cached snapshot for repeat calls, so this is cheap.
    const snapshot = getAppResource(db, userIds);

    // Tracks the snapshot that's actually rendered. On refresh we swap it in inside startTransition
    // so React keeps rendering the previous one until the new promises resolve.
    const [renderedSnapshot, setRenderedSnapshot] = useState(snapshot);

    // Invalidations and userIds changes must reach the rendered state. A useRef lets the refresh
    // callback read the freshest userIds without making `refresh` depend on them.
    const userIdsRef = useRef(userIds);
    userIdsRef.current = userIds;

    // If parent passed a different snapshot identity (e.g. userIds changed), update what's rendered.
    // We don't startTransition here — userIds change is a context shift the user expects to feel.
    if (snapshot !== renderedSnapshot && userIdsRef.current === userIds) {
        setRenderedSnapshot(snapshot);
    }

    const refresh = useCallback(
        (scope: ResourceScope = 'all') => {
            const next = invalidateAppResource(db, userIdsRef.current, scope);
            startTransition(() => setRenderedSnapshot(next));
        },
        [db],
    );

    const value = useMemo<AppResourceContextValue>(() => ({ snapshot: renderedSnapshot, refresh }), [renderedSnapshot, refresh]);

    return <AppResourceContext.Provider value={value}>{children}</AppResourceContext.Provider>;
}
