import { type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, useCallback, useRef } from 'react';
import { isKeyboardEntry, KEYBOARD_REGION_ATTR, ROVING_ITEM_ATTR, regionItems, skipContainerOnShiftTab } from '../lib/keyboardRegionDom';
import { nextRovingIndex, type RovingOrientation } from '../lib/rovingRegion';

interface UseRovingRegionOptions {
    orientation: RovingOrientation;
    /** Shown to screen readers when the region itself takes focus (and names it in the F6 cycle). */
    label: string;
    /**
     * The item to enter on when nothing was used before (e.g. the current page's menu link). With
     * `isPreferredSticky`, it wins over the remembered item too: after any navigation the menu must
     * open on the page you are on, not on the link you last walked to.
     */
    preferredItemSelector?: string;
    isPreferredSticky?: boolean;
}

export interface RovingRegionApi {
    /** Spread on the region's container. */
    regionProps: {
        tabIndex: 0;
        'aria-label': string;
        onFocus: (e: ReactFocusEvent<HTMLElement>) => void;
        onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
        [KEYBOARD_REGION_ATTR]: string;
    };
    /** Spread on every item: out of the tab order, found by the region's arrow keys. */
    itemProps: { tabIndex: -1; [ROVING_ITEM_ATTR]: '' };
}

const isElement = (target: EventTarget | null): target is HTMLElement => target instanceof HTMLElement;

/**
 * One tab stop for a group of controls (the WAI-ARIA toolbar / menu pattern): Tab (or F6) lands on
 * the region, which hands focus to the item used last (or the preferred one, or the first); arrow
 * keys, Home and End walk the items; Tab leaves in one press, and so does Shift+Tab
 * (`skipContainerOnShiftTab`). The container stays tabIndex 0 throughout — no focus state at all.
 */
export function useRovingRegion({ orientation, label, preferredItemSelector, isPreferredSticky = false }: UseRovingRegionOptions): RovingRegionApi {
    const lastItem = useRef<HTMLElement | null>(null);

    const entryItemOf = useCallback(
        (region: HTMLElement) => {
            const items = regionItems(region);
            const preferred = preferredItemSelector ? region.querySelector<HTMLElement>(preferredItemSelector) : null;
            const remembered = lastItem.current && items.includes(lastItem.current) ? lastItem.current : null;
            const usablePreferred = preferred && items.includes(preferred) ? preferred : null;
            return (isPreferredSticky ? (usablePreferred ?? remembered) : (remembered ?? usablePreferred)) ?? items[0];
        },
        [preferredItemSelector, isPreferredSticky],
    );

    const onFocus = useCallback(
        (e: ReactFocusEvent<HTMLElement>) => {
            const item = isElement(e.target) ? e.target.closest<HTMLElement>(`[${ROVING_ITEM_ATTR}]`) : null;
            if (item && e.currentTarget.contains(item)) {
                lastItem.current = item;
                return;
            }
            // Keyboard entry only (Tab, F6): a mouse click on a gap between items also focuses the
            // container, and must not yank focus to a remembered item elsewhere in the region.
            if (e.target === e.currentTarget && isKeyboardEntry(e.currentTarget)) {
                entryItemOf(e.currentTarget)?.focus();
            }
        },
        [entryItemOf],
    );

    const onKeyDown = useCallback(
        (e: ReactKeyboardEvent<HTMLElement>) => {
            const origin = e.target;
            if (e.key === 'Tab' && e.shiftKey) {
                skipContainerOnShiftTab(e.currentTarget, origin);
                return;
            }
            if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || !isElement(origin)) {
                return;
            }
            const items = regionItems(e.currentTarget);
            const next = nextRovingIndex(
                items.length,
                items.findIndex((item) => item.contains(origin)),
                e.key,
                orientation,
            );
            const destination = next === null ? undefined : items[next];
            if (destination) {
                e.preventDefault();
                destination.focus();
            }
        },
        [orientation],
    );

    return {
        regionProps: { tabIndex: 0, 'aria-label': label, onFocus, onKeyDown, [KEYBOARD_REGION_ATTR]: label },
        itemProps: { tabIndex: -1, [ROVING_ITEM_ATTR]: '' },
    };
}
