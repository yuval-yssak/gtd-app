import { type ParsedLocation, useRouter } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useLayoutEffect } from 'react';
import {
    type AnchorRect,
    consensusScrollTop,
    type ListScrollEntry,
    pickVisibleAnchors,
    readFreshListScrollEntry,
    type ScrollFrame,
    saveListScrollEntry,
    scrollTopForAnchor,
} from '../lib/listScrollMemory';

/** Attribute carried by every restorable list row (rendered by ListRowShell, or stamped directly by list routes) — the hook's scroll anchors. */
export const LIST_ANCHOR_ATTRIBUTE = 'data-list-item-id';

interface ScrollSurface {
    /** The element whose scrollTop is read/written. */
    scroller: Element;
    /** Viewport-relative y of the surface's visual top — the reference line for anchor offsets. */
    visualTop: () => number;
    /** Viewport-relative y of the surface's visual bottom — rows below it are off-screen. */
    visualBottom: () => number;
}

/**
 * Resolves what actually scrolls. Today the app shell (`min-height: 100vh`) grows with
 * the content, so the document scrolls and `<main>`'s `overflow: auto` never engages;
 * but if a future layout constrains `<main>`, it becomes the scroller. Resolved at
 * save/restore time (not module load) so it always reflects the current layout.
 */
function resolveScrollSurface(): ScrollSurface | null {
    const main = document.querySelector('main');
    if (main && main.scrollHeight - main.clientHeight > 1) {
        return {
            scroller: main,
            visualTop: () => main.getBoundingClientRect().top,
            visualBottom: () => main.getBoundingClientRect().bottom,
        };
    }
    const documentScroller = document.scrollingElement;
    return documentScroller ? { scroller: documentScroller, visualTop: () => 0, visualBottom: () => window.innerHeight } : null;
}

function collectAnchorRects(): AnchorRect[] {
    return [...document.querySelectorAll<HTMLElement>(`[${LIST_ANCHOR_ATTRIBUTE}]`)].flatMap((rowEl) => {
        const id = rowEl.getAttribute(LIST_ANCHOR_ATTRIBUTE);
        if (!id) {
            return [];
        }
        const rect = rowEl.getBoundingClientRect();
        return [{ id, top: rect.top, bottom: rect.bottom }];
    });
}

function saveCurrentPosition(locationKey: string): void {
    const surface = resolveScrollSurface();
    if (!surface) {
        return;
    }
    const anchors = pickVisibleAnchors({ top: surface.visualTop(), bottom: surface.visualBottom() }, collectAnchorRects());
    saveListScrollEntry(locationKey, { scrollTop: surface.scroller.scrollTop, anchors, savedAtMs: dayjs().valueOf() });
}

/** ScrollTop target per saved anchor that is currently mounted — the consensus vote pool. */
function anchorScrollTargets(surface: ScrollSurface, entry: ListScrollEntry): number[] {
    // Snapshot the frame once: each getBoundingClientRect below forces a layout flush, and
    // re-reading scrollTop/visualTop per anchor could mix baselines mid-loop.
    const frame: ScrollFrame = { currentScrollTop: surface.scroller.scrollTop, containerTop: surface.visualTop() };
    return entry.anchors.flatMap((anchor) => {
        const anchorEl = document.querySelector(`[${LIST_ANCHOR_ATTRIBUTE}="${CSS.escape(anchor.id)}"]`);
        if (!anchorEl) {
            return [];
        }
        return [scrollTopForAnchor(frame, anchorEl.getBoundingClientRect().top, anchor.offset)];
    });
}

/** Frames spent holding at the raw pixel fallback waiting for a second anchor to corroborate (~160ms). */
export const ANCHOR_CORROBORATION_FRAMES = 10;

export interface RestoreDecision {
    /** The scrollTop to assign this frame. */
    target: number;
    /** Whether the retry chain should keep running (beyond clamping) so late-mounting anchors still land. */
    shouldKeepWatching: boolean;
}

/**
 * Two distinct questions per frame: what to assign NOW, and whether to KEEP WATCHING.
 *
 * Assign: a single re-found anchor may be exactly the row the edit MOVED in the sort
 * (often the only saved row mounted right after arrival, since windowed lists mount
 * around the current offset) — following it alone would drag the viewport to its new
 * position. Hold at the raw pixel fallback until a second anchor corroborates the
 * target; a lone survivor is acted on once the short corroboration budget is spent, so
 * a list that genuinely lost most saved rows (bulk done/clarify) repositions early
 * instead of snapping a second later.
 *
 * Keep watching: only the ASSIGNMENT decision is capped by the corroboration budget —
 * the chain keeps running until enough anchors corroborate, so rows a windowed list
 * mounts late (or a shift after a ghost row collapses) still get re-anchored precisely.
 */
export function restoreTargetForFrame(entry: ListScrollEntry, targets: number[], framesLeft: number): RestoreDecision {
    const requiredAnchorMatches = Math.min(entry.anchors.length, 2);
    const framesUsed = RESTORE_RETRY_FRAMES - framesLeft;
    const hasEnoughAnchors = targets.length >= requiredAnchorMatches;
    const shouldKeepWatching = !hasEnoughAnchors;
    if (shouldKeepWatching && framesUsed < ANCHOR_CORROBORATION_FRAMES) {
        return { target: entry.scrollTop, shouldKeepWatching };
    }
    return { target: consensusScrollTop(targets, entry.scrollTop) ?? entry.scrollTop, shouldKeepWatching };
}

// A restore may land while the list is still growing (Suspense fallback / transition
// re-render after a mutation) — the browser clamps scrollTop against the short content
// and nothing re-asserts it. Retry on animation frames until the assignment sticks.
// The generation token cancels stale retry chains when a newer restore supersedes them.
// Module-global: assumes a single active list surface at a time (one route's list in the
// shared shell) — a future split-view would need per-surface generations.
export const RESTORE_RETRY_FRAMES = 60;
let restoreGeneration = 0;
// While a restore chain runs, scroll events are programmatic echoes of the chain's own
// assignments — capturing them would overwrite the accurate saved entry with a provisional
// position (see restoreTargetForFrame's pixel fallback) and freeze the drift in place.
let isRestoreChainActive = false;

function applyRestore(locationKey: string, generation: number, framesLeft: number): void {
    const finishChain = () => {
        if (generation === restoreGeneration) {
            isRestoreChainActive = false;
        }
    };
    const surface = resolveScrollSurface();
    if (!surface) {
        finishChain();
        return;
    }
    const entry = readFreshListScrollEntry(locationKey);
    if (!entry) {
        // Fresh visit (or the sticky window lapsed) — the scroll surface keeps its offset
        // across route changes, so an explicit reset is what makes lists start at the top.
        surface.scroller.scrollTop = 0;
        finishChain();
        return;
    }
    const targets = anchorScrollTargets(surface, entry);
    const { target, shouldKeepWatching } = restoreTargetForFrame(entry, targets, framesLeft);
    surface.scroller.scrollTop = target;
    const wasClamped = Math.abs(surface.scroller.scrollTop - target) > 1;
    // Windowed lists (virtua) don't have the saved anchor rows mounted yet on arrival: the pixel
    // fallback lands nearby (content height is partly estimated, so it drifts), the rows then
    // mount, and a later frame re-anchors precisely. Keep retrying until enough anchors appear.
    // Worst case (anchor rows were deleted and never mount): the chain — and with it the
    // scroll-capture suppression — runs the full retry budget (~1s) before saves resume.
    if ((wasClamped || shouldKeepWatching) && framesLeft > 0) {
        requestAnimationFrame(() => {
            if (generation === restoreGeneration) {
                applyRestore(locationKey, generation, framesLeft - 1);
            }
        });
        return;
    }
    finishChain();
}

/** Hybrid restore: re-anchor on the consensus of surviving saved rows, else fall back to the raw pixel offset. */
function restorePosition(locationKey: string): void {
    restoreGeneration += 1;
    isRestoreChainActive = true;
    applyRestore(locationKey, restoreGeneration, RESTORE_RETRY_FRAMES);
}

function keyOfLocation(location: ParsedLocation): string {
    return `${location.pathname}${location.searchStr}`;
}

/**
 * Restores the list's scroll position when the user returns to it within the sticky
 * window (e.g. after opening an item and coming back), and saves it on leave.
 *
 * Both directions key off router events, not component lifecycle:
 * - Save on `onBeforeLoad` using `event.fromLocation` — the departing page's DOM is still
 *   attached there. (An unmount-cleanup save is unreliable: the router re-renders the old
 *   page with the *new* location before swapping matches, so any location read at cleanup
 *   time already points at the destination.)
 * - Restore on mount (pre-paint, no flash) and again on `onRendered` using
 *   `event.toLocation`: router-core installs a handler (setupScrollRestoration — active
 *   even with the scrollRestoration option unset) that scrolls the window to top on every
 *   navigation render, after this layout effect. Our subscription registers later than
 *   that handler, so it runs after the reset and wins.
 */
export function useListScrollRestoration(): void {
    const router = useRouter();
    useLayoutEffect(() => {
        restorePosition(keyOfLocation(router.latestLocation));
        // Track the position continuously (rAF-throttled) instead of only at departure:
        // onRendered can misfire during a departure while still carrying this page's
        // location, and would restore then — with a live entry that restore is a no-op
        // (it lands where the user already is), so it can't clobber anything. The scroll
        // event reads the settled scrollTop at dispatch time, so programmatic resets that
        // are immediately re-restored coalesce to the correct final position.
        let captureFrame: number | null = null;
        // Once a departure starts, the content swap clamps the scroll (shorter destination
        // page) and fires scroll events that are NOT user intent — capturing them would
        // overwrite the just-saved position. Re-armed on onRendered so in-page replace
        // navigations (filter changes) resume capturing.
        let isDeparting = false;
        const cancelPendingCapture = () => {
            if (captureFrame !== null) {
                cancelAnimationFrame(captureFrame);
                captureFrame = null;
            }
        };
        const captureOnScroll = () => {
            if (isDeparting || isRestoreChainActive || captureFrame !== null) {
                return;
            }
            captureFrame = requestAnimationFrame(() => {
                captureFrame = null;
                // Re-checked here: a restore chain may have started between scheduling and firing.
                if (!isRestoreChainActive) {
                    saveCurrentPosition(keyOfLocation(router.latestLocation));
                }
            });
        };
        window.addEventListener('scroll', captureOnScroll, { capture: true, passive: true });
        const unsubscribeBeforeLoad = router.subscribe('onBeforeLoad', (event) => {
            isDeparting = true;
            cancelPendingCapture();
            // Authoritative final save — the departing page's DOM is still attached here.
            // fromLocation is undefined on the initial load; nothing to save then anyway.
            if (event.fromLocation) {
                saveCurrentPosition(keyOfLocation(event.fromLocation));
            }
        });
        const unsubscribeRendered = router.subscribe('onRendered', (event) => {
            isDeparting = false;
            // Router-core scrolls the window to top on every navigation render (its
            // setupScrollRestoration handler is active even with the option unset) after
            // this page's layout effects — this later-registered subscription re-asserts
            // the saved position on top of that reset.
            restorePosition(keyOfLocation(event.toLocation));
        });
        return () => {
            window.removeEventListener('scroll', captureOnScroll, { capture: true });
            cancelPendingCapture();
            unsubscribeBeforeLoad();
            unsubscribeRendered();
        };
    }, [router]);
}

/**
 * For non-list pages (e.g. item detail) sharing the same scroll surface: start at the
 * top on mount instead of inheriting the previous page's scroll offset.
 */
export function useScrollToTopOnMount(): void {
    useLayoutEffect(() => {
        const surface = resolveScrollSurface();
        if (surface) {
            surface.scroller.scrollTop = 0;
        }
    }, []);
}
