import dayjs from 'dayjs';

/**
 * How long a saved list position stays restorable ("sticky within a flow").
 * Returning to a list within this window — via back-navigation or a nav link —
 * lands at the saved position; after it, the list starts at the top again.
 */
export const SCROLL_STICKY_WINDOW_MS = 5 * 60 * 1000;

export interface ScrollAnchor {
    /** `_id` of the topmost (at least partially) visible row at save time. */
    id: string;
    /** Distance in px from the scroll container's visual top to the anchor row's top at save time (negative when the row is partially scrolled past). */
    offset: number;
}

export interface ListScrollEntry {
    scrollTop: number;
    anchor: ScrollAnchor | null;
    savedAtMs: number;
}

/** Minimal shape of a candidate anchor row — viewport-relative, as returned by getBoundingClientRect. */
export interface AnchorRect {
    id: string;
    top: number;
    bottom: number;
}

// Session-scoped by design: a page reload starts the flow over, so positions need not survive it.
const entriesByLocation = new Map<string, ListScrollEntry>();

export function saveListScrollEntry(locationKey: string, entry: ListScrollEntry): void {
    entriesByLocation.set(locationKey, entry);
}

/** Returns the saved entry for the location if it is still within the sticky window; drops stale entries. */
export function readFreshListScrollEntry(locationKey: string, nowMs = dayjs().valueOf()): ListScrollEntry | null {
    const entry = entriesByLocation.get(locationKey);
    if (!entry) {
        return null;
    }
    if (nowMs - entry.savedAtMs > SCROLL_STICKY_WINDOW_MS) {
        entriesByLocation.delete(locationKey);
        return null;
    }
    return entry;
}

export function resetListScrollMemory(): void {
    entriesByLocation.clear();
}

/** Picks the topmost row still (at least partially) visible below the container's top edge. */
export function pickTopVisibleAnchor(containerTop: number, rows: AnchorRect[]): ScrollAnchor | null {
    const anchorRow = rows.find((row) => row.bottom > containerTop);
    return anchorRow ? { id: anchorRow.id, offset: anchorRow.top - containerTop } : null;
}

/** Computes the scrollTop that puts the anchor row back at its saved visual offset. */
export function scrollTopForAnchor(currentScrollTop: number, containerTop: number, anchorTop: number, savedOffset: number): number {
    return currentScrollTop + (anchorTop - containerTop) - savedOffset;
}
