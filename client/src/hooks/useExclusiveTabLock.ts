import { useEffect, useState } from 'react';
import { hasWebLocks } from '../db/crossContextLock';
import { acquireExclusiveTabLock, type TabLockOwnership } from '../lib/exclusiveTabLock';

/** `pending` until the first answer (or while there is no name to lock). */
export type TabLockState = TabLockOwnership | 'pending';

interface TabLockSnapshot {
    name: string;
    state: TabLockState;
    /** Gains of the lock under this name — a change means "reload what you keep in memory". */
    generation: number;
}

/**
 * Makes one tab (per lock name, across the origin) the OWNER of a screen. The first tab to ask
 * holds the Web Lock; others see `heldElsewhere` and queue behind it, so closing the owner hands
 * the lock to a waiting tab on its own. `takeOver()` steals it ("Continue here") — the previous
 * owner drops back to `heldElsewhere`, queued again. Protocol: `lib/exclusiveTabLock.ts`.
 *
 * A null name (e.g. no account yet) requests nothing. Without the Web Locks API every tab simply
 * holds it — the behaviour before the lock existed.
 */
export function useExclusiveTabLock(name: string | null) {
    const [snapshot, setSnapshot] = useState<TabLockSnapshot | null>(null);
    // Keyed by name: a takeover asked for one account must never steal another account's lock.
    const [takeOverFor, setTakeOverFor] = useState<{ name: string; count: number } | null>(null);
    // A takeover is spent once this tab leaves that name; keeping it would steal again on the way
    // back (A → B → A). Cleared during render — clearing it after the gain would re-run the effect
    // and release the lock just taken.
    if (takeOverFor && takeOverFor.name !== name) {
        setTakeOverFor(null);
    }
    const lock = currentLock(name, snapshot);
    const shouldSteal = name !== null && takeOverFor?.name === name;

    useEffect(() => {
        if (name === null || !hasWebLocks()) {
            return;
        }
        const controller = new AbortController();
        acquireExclusiveTabLock({
            name,
            steal: shouldSteal,
            signal: controller.signal,
            onOwnershipChange: (ownership) => setSnapshot((previous) => nextSnapshot(name, previous, ownership)),
        });
        return () => controller.abort();
        // takeOverFor: each "Continue here" click is a new steal, even for the same name.
    }, [name, shouldSteal, takeOverFor]);

    function takeOver() {
        if (name === null || lock.state !== 'heldElsewhere') {
            return;
        }
        setTakeOverFor((previous) => ({ name, count: (previous?.count ?? 0) + 1 }));
    }

    return { state: lock.state, generation: lock.generation, takeOver };
}

/** A snapshot for another name is stale — the new name starts pending, never inheriting ownership. */
function currentLock(name: string | null, snapshot: TabLockSnapshot | null) {
    if (name !== null && !hasWebLocks()) {
        return { state: 'held' as const, generation: 1 };
    }
    return snapshot && snapshot.name === name ? snapshot : { state: 'pending' as const, generation: 0 };
}

function nextSnapshot(name: string, previous: TabLockSnapshot | null, ownership: TabLockOwnership): TabLockSnapshot {
    const generation = previous?.name === name ? previous.generation : 0;
    return { name, state: ownership, generation: ownership === 'held' ? generation + 1 : generation };
}
