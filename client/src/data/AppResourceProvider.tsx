import type { IDBPDatabase } from 'idb';
import { createContext, type PropsWithChildren, startTransition, useCallback, useContext, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { MyDB } from '../types/MyDB';
import {
    type AppResourceSnapshot,
    appResourceKey,
    getAppResource,
    invalidateAppResource,
    type ResourceScope,
    registerAppResourceRefreshHandler,
    shouldAdoptSnapshotDuringRender,
} from './appResource';

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

    // Adopt the derived snapshot during render ONLY when the (db, userIds) key changed — an account
    // added/removed. See shouldAdoptSnapshotDuringRender for why keying on the cache key (not
    // snapshot identity) is load-bearing; invalidation swaps must flow only through `refresh`.
    const key = appResourceKey(db, userIds);
    const [renderedKey, setRenderedKey] = useState(key);
    if (shouldAdoptSnapshotDuringRender(renderedKey, key)) {
        setRenderedKey(key);
        setRenderedSnapshot(snapshot);
    }

    const refresh = useCallback(
        (scope: ResourceScope = 'all') => {
            const next = invalidateAppResource(db, userIdsRef.current, scope);
            startTransition(() => setRenderedSnapshot(next));
        },
        [db],
    );

    // Expose refresh through the module-level handler so the sync layer (and the legacy
    // AppDataProvider above us) can trigger a resource refresh without importing context.
    useEffect(() => registerAppResourceRefreshHandler(refresh), [refresh]);

    // Deferred, so a key shift renders the new snapshot in the background and the current one stays
    // on screen until it resolves. Adopted urgently, the shift suspended the provider's consumers to
    // the boot boundary above the app shell: the multi-session seed adding an account just after
    // boot flashed the whole shell hidden and dropped keyboard focus to <body>. The first mount
    // still suspends normally, so boot renders the shell and its data together.
    const shownSnapshot = useDeferredValue(renderedSnapshot);

    const value = useMemo<AppResourceContextValue>(() => ({ snapshot: shownSnapshot, refresh }), [shownSnapshot, refresh]);

    return <AppResourceContext.Provider value={value}>{children}</AppResourceContext.Provider>;
}
