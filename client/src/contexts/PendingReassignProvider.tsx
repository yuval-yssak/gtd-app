import Snackbar from '@mui/material/Snackbar';
import type { IDBPDatabase } from 'idb';
import { createContext, type PropsWithChildren, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReassignParams } from '../api/syncApi';
import { reassignEntity } from '../db/reassignMutations';
import type { MyDB, StoredItem, StoredRoutine } from '../types/MyDB';

/**
 * Presentational-only override applied to the source-account row while a /sync/reassign request
 * is in flight. The fields here are rewritten on the rendered StoredItem/StoredRoutine so the
 * unified item lists immediately show the entity under the target account; the underlying IDB
 * row is untouched until the server confirms and the SSE pull lands. We only ever set fields
 * that are safe to forge (account ownership + calendar config refs) — never identity (`_id`,
 * `calendarEventId`). The post-pull row carries a NEW calendarEventId from the target calendar,
 * but no UI code uses calendarEventId for rendering decisions, so keeping the old one in the
 * overlay-rendered frame is harmless.
 */
export interface PendingReassignOverride {
    toUserId: string;
    /**
     * Optional new calendar config — set when reassigning a calendar-linked item or routine.
     * Without these, the item would still appear under the old calendar in the target account.
     */
    targetIntegrationId?: string;
    targetSyncConfigId?: string;
}

type EntityKind = 'item' | 'routine';

export interface ReassignWithOverlayRequest {
    kind: EntityKind;
    entityId: string;
    /** Human label for the snackbar so bursts of failures can be disambiguated. */
    label: string;
    override: PendingReassignOverride;
    params: ReassignParams;
}

interface PendingReassignAPI {
    /** True while a reassign for this entity is in flight. Used by dialogs to refuse re-edit. */
    isPending: (kind: EntityKind, entityId: string) => boolean;
    /**
     * Fire-and-forget reassign. Registers the overlay synchronously, returns a promise that
     * resolves once the server call completes (success or failure). On failure the overlay is
     * cleared and a revert snackbar shown — callers don't need to handle the rejection. Calling
     * this for an entity that already has a pending overlay is a no-op (returns immediately).
     */
    runReassignWithOverlay: (req: ReassignWithOverlayRequest) => Promise<void>;
}

const PendingReassignContext = createContext<PendingReassignAPI | undefined>(undefined);

export function usePendingReassign(): PendingReassignAPI {
    const ctx = useContext(PendingReassignContext);
    if (!ctx) {
        throw new Error('usePendingReassign must be used within a PendingReassignProvider');
    }
    return ctx;
}

/**
 * Generic overlay applier. The two callers below pin the entity type so consumers don't widen
 * via a union — and the function preserves the input type via the `T` parameter so the result
 * is StoredItem when called with StoredItem, StoredRoutine when called with StoredRoutine.
 */
function applyOverride<T extends { userId: string; calendarIntegrationId?: string; calendarSyncConfigId?: string }>(
    entity: T,
    override: PendingReassignOverride,
): T {
    const next: T = { ...entity, userId: override.toUserId };
    if (override.targetIntegrationId !== undefined) {
        next.calendarIntegrationId = override.targetIntegrationId;
    }
    if (override.targetSyncConfigId !== undefined) {
        next.calendarSyncConfigId = override.targetSyncConfigId;
    }
    return next;
}

export function applyOverrideToItem(item: StoredItem, override: PendingReassignOverride): StoredItem {
    return applyOverride(item, override);
}

export function applyOverrideToRoutine(routine: StoredRoutine, override: PendingReassignOverride): StoredRoutine {
    return applyOverride(routine, override);
}

interface PendingMaps {
    items: ReadonlyMap<string, PendingReassignOverride>;
    routines: ReadonlyMap<string, PendingReassignOverride>;
}

/**
 * Hook variant of `usePendingReassign` exposing the raw overlay maps so AppDataProvider can
 * cheaply re-derive `items`/`routines` only when an entry actually changes (Map identity flips
 * on register/clear). Kept internal-ish — routes use `usePendingReassign` instead.
 */
export function usePendingReassignMaps(): PendingMaps {
    const ctx = useContext(PendingMapsContext);
    if (!ctx) {
        throw new Error('usePendingReassignMaps must be used within a PendingReassignProvider');
    }
    return ctx;
}

const PendingMapsContext = createContext<PendingMaps | undefined>(undefined);

interface ProviderProps {
    db: IDBPDatabase<MyDB>;
}

interface RevertNotice {
    /** Monotonic id so two distinct failures re-trigger the Snackbar's open transition. */
    id: number;
    message: string;
}

export function PendingReassignProvider({ db, children }: PropsWithChildren<ProviderProps>) {
    const [itemOverrides, setItemOverrides] = useState<ReadonlyMap<string, PendingReassignOverride>>(new Map());
    const [routineOverrides, setRoutineOverrides] = useState<ReadonlyMap<string, PendingReassignOverride>>(new Map());
    const [revertNotice, setRevertNotice] = useState<RevertNotice | null>(null);
    const noticeIdRef = useRef(0);

    // Skip setState calls after unmount so a stale revert notice from a fully-signed-out
    // session can't appear on top of the next session's screen.
    const unmountedRef = useRef(false);
    useEffect(() => {
        return () => {
            unmountedRef.current = true;
        };
    }, []);

    const setOverride = useCallback((kind: EntityKind, entityId: string, override: PendingReassignOverride) => {
        const setter = kind === 'item' ? setItemOverrides : setRoutineOverrides;
        setter((prev) => {
            const next = new Map(prev);
            next.set(entityId, override);
            return next;
        });
    }, []);

    const clearOverride = useCallback((kind: EntityKind, entityId: string) => {
        const setter = kind === 'item' ? setItemOverrides : setRoutineOverrides;
        setter((prev) => {
            if (!prev.has(entityId)) {
                return prev;
            }
            const next = new Map(prev);
            next.delete(entityId);
            return next;
        });
    }, []);

    const isPending = useCallback(
        (kind: EntityKind, entityId: string) => {
            const map = kind === 'item' ? itemOverrides : routineOverrides;
            return map.has(entityId);
        },
        [itemOverrides, routineOverrides],
    );

    // Synchronous in-flight key set, updated at the top of `runReassignWithOverlay` BEFORE the
    // React state setter. Two calls fired in the same event-loop tick would both see an empty
    // override map (the React state hasn't committed yet), so the React-state guard alone isn't
    // sufficient — this Set closes that race. Cleared in the same `finally` as the React state.
    const inFlightKeysRef = useRef<Set<string>>(new Set());

    const showRevert = useCallback((message: string) => {
        if (unmountedRef.current) {
            return;
        }
        noticeIdRef.current += 1;
        setRevertNotice({ id: noticeIdRef.current, message });
    }, []);

    const runReassignWithOverlay = useCallback(
        async (req: ReassignWithOverlayRequest) => {
            // In-flight guard. Two calls in the same event-loop tick would both observe an
            // empty React-state map (state hasn't committed yet), so we use a synchronous Set
            // mutated before the state setter. Without this, the second call's setOverride
            // clobbers the first's, and the first's `finally` clearOverride wipes out the
            // second's overlay before its network call returns.
            const key = `${req.kind}:${req.entityId}`;
            if (inFlightKeysRef.current.has(key)) {
                return;
            }
            inFlightKeysRef.current.add(key);
            // Register the overlay before firing the network call. The order matters —
            // registering after the await would leave a render frame where IDB is unchanged AND
            // no overlay is in place, briefly showing the entity under the source account.
            setOverride(req.kind, req.entityId, req.override);
            try {
                const result = await reassignEntity(db, req.params);
                if (!result.ok) {
                    showRevert(`Couldn't move "${req.label}" — reverted (${result.error})`);
                }
                // On success the SSE pull (inside reassignEntity → syncAllLoggedInUsers) has
                // already updated IDB. Clearing the overlay here lets the real row take over;
                // the post-pull userId equals override.toUserId so the rendered entity is
                // identical and the user sees no flicker.
            } catch (err) {
                console.error('[reassign] unexpected failure:', err);
                showRevert(`Couldn't move "${req.label}" — reverted`);
            } finally {
                inFlightKeysRef.current.delete(key);
                if (!unmountedRef.current) {
                    clearOverride(req.kind, req.entityId);
                }
            }
        },
        [db, setOverride, clearOverride, showRevert],
    );

    const api = useMemo<PendingReassignAPI>(() => ({ isPending, runReassignWithOverlay }), [isPending, runReassignWithOverlay]);
    const maps = useMemo<PendingMaps>(() => ({ items: itemOverrides, routines: routineOverrides }), [itemOverrides, routineOverrides]);

    return (
        <PendingReassignContext.Provider value={api}>
            <PendingMapsContext.Provider value={maps}>
                {children}
                {/*
                 * Layout-level snackbar for revert notices. Keyed by `id` so two distinct
                 * failures in quick succession re-trigger the open transition rather than
                 * silently swapping the message of an already-open snackbar.
                 */}
                <Snackbar
                    key={revertNotice?.id ?? 'idle'}
                    open={revertNotice !== null}
                    autoHideDuration={5000}
                    onClose={() => setRevertNotice(null)}
                    message={revertNotice?.message ?? ''}
                />
            </PendingMapsContext.Provider>
        </PendingReassignContext.Provider>
    );
}
