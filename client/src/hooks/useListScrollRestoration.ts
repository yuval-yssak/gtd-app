import { type ParsedLocation, useRouter } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useLayoutEffect } from 'react';
import {
    type AnchorRect,
    type ListScrollEntry,
    pickTopVisibleAnchor,
    readFreshListScrollEntry,
    saveListScrollEntry,
    scrollTopForAnchor,
} from '../lib/listScrollMemory';

/** Attribute carried by every restorable list row (rendered by ListRowShell) — the hook's scroll anchors. */
export const LIST_ANCHOR_ATTRIBUTE = 'data-list-item-id';

interface ScrollSurface {
    /** The element whose scrollTop is read/written. */
    scroller: Element;
    /** Viewport-relative y of the surface's visual top — the reference line for anchor offsets. */
    visualTop: () => number;
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
        return { scroller: main, visualTop: () => main.getBoundingClientRect().top };
    }
    const documentScroller = document.scrollingElement;
    return documentScroller ? { scroller: documentScroller, visualTop: () => 0 } : null;
}

function collectAnchorRects(): AnchorRect[] {
    return [...document.querySelectorAll<HTMLElement>(`[${LIST_ANCHOR_ATTRIBUTE}]`)]
        .map((rowEl) => {
            const rect = rowEl.getBoundingClientRect();
            return { id: rowEl.getAttribute(LIST_ANCHOR_ATTRIBUTE) ?? '', top: rect.top, bottom: rect.bottom };
        })
        .filter((anchor) => anchor.id !== '');
}

function saveCurrentPosition(locationKey: string): void {
    const surface = resolveScrollSurface();
    if (!surface) {
        return;
    }
    const anchor = pickTopVisibleAnchor(surface.visualTop(), collectAnchorRects());
    saveListScrollEntry(locationKey, { scrollTop: surface.scroller.scrollTop, anchor, savedAtMs: dayjs().valueOf() });
}

/** Anchor-first target: where the saved row sits now, else the raw saved pixel offset. */
function desiredScrollTop(surface: ScrollSurface, entry: ListScrollEntry): number {
    const anchorEl = entry.anchor && document.querySelector(`[${LIST_ANCHOR_ATTRIBUTE}="${CSS.escape(entry.anchor.id)}"]`);
    if (entry.anchor && anchorEl) {
        return scrollTopForAnchor(surface.scroller.scrollTop, surface.visualTop(), anchorEl.getBoundingClientRect().top, entry.anchor.offset);
    }
    return entry.scrollTop;
}

// A restore may land while the list is still growing (Suspense fallback / transition
// re-render after a mutation) — the browser clamps scrollTop against the short content
// and nothing re-asserts it. Retry on animation frames until the assignment sticks.
// The generation token cancels stale retry chains when a newer restore supersedes them.
// Module-global: assumes a single active list surface at a time (one route's list in the
// shared shell) — a future split-view would need per-surface generations.
const RESTORE_RETRY_FRAMES = 60;
let restoreGeneration = 0;

function applyRestore(locationKey: string, generation: number, framesLeft: number): void {
    const surface = resolveScrollSurface();
    if (!surface) {
        return;
    }
    const entry = readFreshListScrollEntry(locationKey);
    if (!entry) {
        // Fresh visit (or the sticky window lapsed) — the scroll surface keeps its offset
        // across route changes, so an explicit reset is what makes lists start at the top.
        surface.scroller.scrollTop = 0;
        return;
    }
    const target = desiredScrollTop(surface, entry);
    surface.scroller.scrollTop = target;
    const wasClamped = Math.abs(surface.scroller.scrollTop - target) > 1;
    if (wasClamped && framesLeft > 0) {
        requestAnimationFrame(() => {
            if (generation === restoreGeneration) {
                applyRestore(locationKey, generation, framesLeft - 1);
            }
        });
    }
}

/** Hybrid restore: re-anchor on the saved row when it still exists, else fall back to the raw pixel offset. */
function restorePosition(locationKey: string): void {
    restoreGeneration += 1;
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
            if (isDeparting || captureFrame !== null) {
                return;
            }
            captureFrame = requestAnimationFrame(() => {
                captureFrame = null;
                saveCurrentPosition(keyOfLocation(router.latestLocation));
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
