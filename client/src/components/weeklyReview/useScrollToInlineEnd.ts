import { useEffect } from 'react';

/** The geometry `hiddenEdges` reads — an element's horizontal scroll box. */
interface ScrollBox {
    scrollLeft: number;
    scrollWidth: number;
    clientWidth: number;
}

// Below a pixel is rounding (fractional scrollLeft on high-DPI screens), not a hidden button.
const EDGE_TOLERANCE_PX = 1;

/** Which edges of a horizontally scrolling row have content scrolled out of view beyond them. */
export function hiddenEdges({ scrollLeft, scrollWidth, clientWidth }: ScrollBox) {
    return {
        start: scrollLeft > EDGE_TOLERANCE_PX,
        end: scrollWidth - clientWidth - scrollLeft > EDGE_TOLERANCE_PX,
    };
}

/**
 * Keeps a horizontally scrolling row scrolled to its END whenever its children or their sizes
 * change. The weekly review's action bar holds its primary action last, so on a phone — where the
 * row scrolls instead of wrapping — each new card opens on "Looks good" / Done, with the rest a
 * swipe away. Focus wins: when a button inside the row holds focus (a keyboard walk of an overdue
 * backlog refocuses the action the user pressed), that button is revealed instead. The row's
 * `data-hidden-start` / `data-hidden-end` flags drive the CSS edge fades that hint at the rest.
 */
export function useScrollToInlineEnd(row: HTMLElement | null) {
    useEffect(() => {
        if (!row) {
            return;
        }
        const markEdges = () => flagHiddenEdges(row);
        const reveal = () => {
            revealFocusOrEnd(row);
            markEdges();
        };
        // Children resize without the row resizing ("Looks good" → "Save & next", Missed appearing
        // inside the portaled row), so every child is observed and re-attached as children swap.
        const resizes = new ResizeObserver(reveal);
        const observeChildren = () => {
            resizes.disconnect();
            resizes.observe(row);
            for (const child of row.children) {
                resizes.observe(child);
            }
        };
        // Portaled editor actions replace the row's children on every card, without any re-render here.
        const childChanges = new MutationObserver(() => {
            observeChildren();
            reveal();
        });
        childChanges.observe(row, { childList: true });
        row.addEventListener('scroll', markEdges, { passive: true });
        observeChildren();
        reveal();
        return () => {
            childChanges.disconnect();
            resizes.disconnect();
            row.removeEventListener('scroll', markEdges);
        };
    }, [row]);
}

function revealFocusOrEnd(row: HTMLElement) {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && row.contains(focused)) {
        focused.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        return;
    }
    row.scrollTo({ left: row.scrollWidth });
}

function flagHiddenEdges(row: HTMLElement) {
    const edges = hiddenEdges(row);
    row.toggleAttribute('data-hidden-start', edges.start);
    row.toggleAttribute('data-hidden-end', edges.end);
}
