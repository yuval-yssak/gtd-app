/**
 * Single-level undo store for the autosave/save snackbar ("Saved — UNDO").
 *
 * Module-level (not React state) so db-layer callers and editor components can offer undos without
 * a context dependency; the UndoSnackbar component subscribes via useSyncExternalStore.
 *
 * Semantics:
 * - At most one offer is live at a time. Offering with the SAME `key` replaces the entry silently —
 *   that's a continuing autosave burst refreshing its snackbar. Offering with a DIFFERENT key first
 *   fires the old entry's `onExpire` (its burst is over) and then replaces it.
 * - `dismissCurrentUndo()` (timeout, close button, navigation) fires `onExpire` — the owning
 *   autosave controller uses that to end its burst so the next edit captures a fresh baseline.
 * - `runCurrentUndo()` executes the restore callback and clears the entry without firing
 *   `onExpire` — the undo callback itself is responsible for re-baselining its controller.
 */

export interface UndoOffer {
    /** Stable identity of the undo source, e.g. `item:<id>:text`. Same key ⇒ same burst. */
    key: string;
    message: string;
    undo: () => Promise<void>;
    /** Optional in-app path (e.g. `/item/<id>`) surfaced as a "View" link alongside the Undo action. */
    link?: string;
    /** Fired when the offer leaves the screen without being undone (timeout/dismiss/superseded). */
    onExpire?: () => void;
}

interface UndoEntry extends UndoOffer {
    /** Monotonic id so the snackbar can re-trigger its auto-hide timer on burst refreshes. */
    offerId: number;
}

let current: UndoEntry | null = null;
let nextOfferId = 1;
const listeners = new Set<() => void>();

function notify(): void {
    for (const listener of listeners) {
        listener();
    }
}

export function offerUndo(offer: UndoOffer): void {
    if (current && current.key !== offer.key) {
        current.onExpire?.();
    }
    current = { ...offer, offerId: nextOfferId++ };
    notify();
}

export function dismissCurrentUndo(): void {
    if (!current) {
        return;
    }
    const entry = current;
    current = null;
    notify();
    entry.onExpire?.();
}

export async function runCurrentUndo(): Promise<void> {
    if (!current) {
        return;
    }
    const entry = current;
    current = null;
    notify();
    await entry.undo();
}

export function subscribeToUndo(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getCurrentUndo(): UndoEntry | null {
    return current;
}

export function resetUndoStore(): void {
    current = null;
    nextOfferId = 1;
}
