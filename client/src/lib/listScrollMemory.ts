import dayjs from 'dayjs';
import { hasAtLeastOne, type NonEmptyArray } from './typeUtils';

/**
 * How long a saved list position stays restorable ("sticky within a flow").
 * Returning to a list within this window — via back-navigation or a nav link —
 * lands at the saved position; after it, the list starts at the top again.
 */
export const SCROLL_STICKY_WINDOW_MS = 5 * 60 * 1000;

/**
 * Cap on how many visible rows are remembered as anchors — a safety valve on a
 * viewport-sized set (a viewport shows ~5-8 rows), not a selection rule. One anchor
 * is not enough: it is usually the very row the user opened, and if the edit moved
 * that row in the sort, restoring would follow it instead of keeping the rest of
 * the list in place.
 */
export const MAX_SAVED_ANCHORS = 12;

/**
 * Two anchor-derived scroll targets within this many px count as agreeing on one position.
 * Roughly half a row height — sub-row jitter (a wrapping chip line, a resized row) counts
 * as agreement; a shift of a full row or more does not.
 */
export const ANCHOR_AGREEMENT_TOLERANCE_PX = 32;

export interface ScrollAnchor {
    /** `_id` of a row visible (at least partially) at save time. */
    id: string;
    /** Distance in px from the scroll container's visual top to the anchor row's top at save time (negative when the row is partially scrolled past). */
    offset: number;
}

export interface ListScrollEntry {
    scrollTop: number;
    /** Visible rows top→bottom at save time (up to MAX_SAVED_ANCHORS). */
    anchors: ScrollAnchor[];
    savedAtMs: number;
}

/** Minimal shape of a candidate anchor row — viewport-relative, as returned by getBoundingClientRect. */
export interface AnchorRect {
    id: string;
    top: number;
    bottom: number;
}

// Tab-scoped: the in-memory map is the source of truth, mirrored to sessionStorage so a
// page reload lands back at the same position. The mirror follows the map's eviction and
// capacity rules, not just its writes — an entry the sticky window discarded must not
// come back on reload. sessionStorage (not localStorage) keeps the memory per-tab — two
// tabs on the same list never fight over one saved position.
const entriesByLocation = new Map<string, ListScrollEntry>();

const SESSION_STORAGE_KEY = 'gtd:listScrollPositions';

/**
 * Cap on persisted locations: keys include search params (/search?q=…), so a long-lived
 * tab would otherwise accumulate one immortal key per typed query until the storage
 * quota silently kills persistence altogether.
 */
export const MAX_PERSISTED_LOCATIONS = 50;

/**
 * The location the tab actually (re)loaded at — captured at module load, before any
 * navigation, so the reload age-refresh applies to the reloaded page even when the
 * first list to mount the hook is a different one (e.g. reload on /item/:id, then
 * navigate to a list).
 */
const RELOADED_LOCATION_KEY = typeof location === 'undefined' ? null : `${location.pathname}${location.search}`;

let isHydratedFromSession = false;

/** Newest-first entries still inside the sticky window, capped — the only shape the mirror stores. */
function freshestEntries(nowMs: number): [string, ListScrollEntry][] {
    return [...entriesByLocation]
        .filter(([, entry]) => nowMs - entry.savedAtMs <= SCROLL_STICKY_WINDOW_MS)
        .sort(([, a], [, b]) => b.savedAtMs - a.savedAtMs)
        .slice(0, MAX_PERSISTED_LOCATIONS);
}

function persistEntriesToSession(nowMs: number): void {
    try {
        sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(Object.fromEntries(freshestEntries(nowMs))));
    } catch {
        // Storage unavailable or full (private mode, quota, node tests) — the in-memory map
        // still works; only reload survival degrades.
    }
}

function readSessionEntries(): Record<string, unknown> {
    try {
        const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

// Validation guard for values crossing the JSON boundary — the one place a cast is justified.
function isPersistedEntry(candidate: unknown): candidate is ListScrollEntry {
    if (typeof candidate !== 'object' || candidate === null) {
        return false;
    }
    const { scrollTop, anchors, savedAtMs } = candidate as Partial<ListScrollEntry>;
    return typeof scrollTop === 'number' && Array.isArray(anchors) && typeof savedAtMs === 'number';
}

/**
 * The hydration merge rule. The reloaded page restores regardless of idle time (native
 * scroll-restoration parity) — its age is refreshed; other locations keep their real age,
 * and ones already past the sticky window stay dead instead of entering the map.
 */
function admitPersistedEntry(locationKey: string, entry: ListScrollEntry, reloadedLocationKey: string | null, nowMs: number): void {
    if (entriesByLocation.has(locationKey)) {
        return;
    }
    if (locationKey === reloadedLocationKey) {
        entriesByLocation.set(locationKey, { ...entry, savedAtMs: nowMs });
        return;
    }
    if (nowMs - entry.savedAtMs <= SCROLL_STICKY_WINDOW_MS) {
        entriesByLocation.set(locationKey, entry);
    }
}

/**
 * Loads the positions this tab persisted before a reload (see admitPersistedEntry for the
 * merge rule). In-memory entries always win over persisted ones. Idempotent — only the
 * first call per page load reads storage. The parameters exist for tests; production
 * callers rely on the defaults.
 */
export function hydrateListScrollMemory(reloadedLocationKey = RELOADED_LOCATION_KEY, nowMs = dayjs().valueOf()): void {
    if (isHydratedFromSession) {
        return;
    }
    isHydratedFromSession = true;
    for (const [locationKey, entry] of Object.entries(readSessionEntries())) {
        if (isPersistedEntry(entry)) {
            admitPersistedEntry(locationKey, entry, reloadedLocationKey, nowMs);
        }
    }
}

export function saveListScrollEntry(locationKey: string, entry: ListScrollEntry): void {
    entriesByLocation.set(locationKey, entry);
    // The entry's own timestamp is "now" from the caller's clock — using it keeps the
    // mirror's pruning on the same clock as the entries (real time in prod, fake in tests).
    persistEntriesToSession(entry.savedAtMs);
}

/** Returns the saved entry for the location if it is still within the sticky window; drops stale entries. */
export function readFreshListScrollEntry(locationKey: string, nowMs = dayjs().valueOf()): ListScrollEntry | null {
    const entry = entriesByLocation.get(locationKey);
    if (!entry) {
        return null;
    }
    if (nowMs - entry.savedAtMs > SCROLL_STICKY_WINDOW_MS) {
        entriesByLocation.delete(locationKey);
        // Write-through: a position the app visibly discarded must not resurrect on reload.
        persistEntriesToSession(nowMs);
        return null;
    }
    return entry;
}

/**
 * Wipes both the map and the mirror. Scroll positions are per-account (anchors are item
 * _ids), and an account switch hard-reloads the same URL — without this, the previous
 * account's offset would restore onto the next account's completely different list.
 */
export function clearPersistedListScrollMemory(): void {
    entriesByLocation.clear();
    try {
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
        // Storage unavailable — the in-memory clear above is the part that matters.
    }
}

export function resetListScrollMemory(): void {
    entriesByLocation.clear();
    isHydratedFromSession = false;
}

/** The scroll container's visible band in viewport coordinates — rows outside it are off-screen. */
export interface ViewportBand {
    top: number;
    bottom: number;
}

/** Picks the rows at least partially inside the container's visible band, topmost first. */
export function pickVisibleAnchors(viewport: ViewportBand, rows: AnchorRect[]): ScrollAnchor[] {
    return rows
        .filter((row) => row.bottom > viewport.top && row.top < viewport.bottom)
        .slice(0, MAX_SAVED_ANCHORS)
        .map((row) => ({ id: row.id, offset: row.top - viewport.top }));
}

/** The scroll container's current position, snapshotted once per measurement pass. */
export interface ScrollFrame {
    currentScrollTop: number;
    containerTop: number;
}

/** Computes the scrollTop that puts the anchor row back at its saved visual offset. */
export function scrollTopForAnchor(frame: ScrollFrame, anchorTop: number, savedOffset: number): number {
    return frame.currentScrollTop + (anchorTop - frame.containerTop) - savedOffset;
}

/** A run of anchor targets that agree on one position: how many, and the position they elect. */
interface AnchorCluster {
    size: number;
    median: number;
}

function medianOfSorted([first, ...rest]: NonEmptyArray<number>): number {
    const sorted = [first, ...rest];
    const midpoint = (sorted.length - 1) / 2;
    // ?? never fires (both indices are in range) — it satisfies noUncheckedIndexedAccess
    // without a `!` assertion, which Biome's noNonNullAssertion warning would flag.
    return ((sorted[Math.floor(midpoint)] ?? first) + (sorted[Math.ceil(midpoint)] ?? first)) / 2;
}

/**
 * The agreeing run beginning at `start`: every following target within the tolerance of
 * the run's FIRST member. Span-bounded (not a per-candidate radius), so a chain of
 * near-neighbors spread across several tolerances can't masquerade as one agreement.
 */
function clusterFrom(start: number, followers: number[], tolerancePx: number): AnchorCluster {
    const run: NonEmptyArray<number> = [start, ...followers.filter((target) => target - start <= tolerancePx)];
    return { size: run.length, median: medianOfSorted(run) };
}

function isStrongerCluster(candidate: AnchorCluster, best: AnchorCluster, savedScrollTop: number): boolean {
    if (candidate.size !== best.size) {
        return candidate.size > best.size;
    }
    const candidateDistance = Math.abs(candidate.median - savedScrollTop);
    const bestDistance = Math.abs(best.median - savedScrollTop);
    if (candidateDistance !== bestDistance) {
        return candidateDistance < bestDistance;
    }
    // Equal size and equal distance: prefer the lower target so the result is input-order independent.
    return candidate.median < best.median;
}

/**
 * Picks the restore target the largest cluster of anchors agrees on. Anchors that kept
 * their relative order all compute (nearly) the same scrollTop; a row the edit moved in
 * the sort computes an outlier target — following it would drag the viewport along, so
 * the majority wins. Ties go to the cluster closest to the raw saved scrollTop, since an
 * unchanged list restores near that pixel anyway.
 */
export function consensusScrollTop(targets: number[], savedScrollTop: number, tolerancePx = ANCHOR_AGREEMENT_TOLERANCE_PX): number | null {
    const sortedTargets = [...targets].sort((a, b) => a - b);
    const clusters = sortedTargets.map((start, index) => clusterFrom(start, sortedTargets.slice(index + 1), tolerancePx));
    if (!hasAtLeastOne(clusters)) {
        return null;
    }
    const [firstCluster, ...otherClusters] = clusters;
    return otherClusters.reduce((best, cluster) => (isStrongerCluster(cluster, best, savedScrollTop) ? cluster : best), firstCluster).median;
}
