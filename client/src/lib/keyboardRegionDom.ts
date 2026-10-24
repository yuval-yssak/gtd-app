/**
 * DOM glue shared by the keyboard regions (`hooks/useRovingRegion.ts`, the Next Actions list) and
 * the global shortcuts (`hooks/useGlobalShortcuts.ts`). `isModalOpen` is unit-tested under jsdom
 * (`tests/keyboardRegionDom.test.ts`); the focus helpers are covered by `e2e/keyboard-regions.spec.ts`.
 */

/** Marks a region's container (F6 cycles them) and each item a region's arrow keys walk. */
export const KEYBOARD_REGION_ATTR = 'data-keyboard-region';
export const ROVING_ITEM_ATTR = 'data-roving-item';
/** Marks the shared list-search toggle and its input, so `/` works on every list page. */
export const LIST_SEARCH_TOGGLE_ATTR = 'data-list-search-toggle';
export const LIST_SEARCH_INPUT_ATTR = 'data-list-search-input';

/**
 * Stamped by every design-system popup that must silence page shortcuts while open (dialogs,
 * drawers, menus, popovers, select and combobox lists) — never by tooltips or toasts.
 */
export const MODAL_POPUP_ATTR = 'data-modal-popup';

/**
 * An open modal popup. Base UI stamps `data-open` while open (and `data-closed` through the exit
 * animation), and the design system never keep-mounts a closed popup. The MUI half covers the
 * screens not yet migrated: its keep-mounted modals (AppNav's mobile drawer) stay in the DOM and
 * are marked aria-hidden while closed, so bare presence ≠ open.
 */
export function isModalOpen(): boolean {
    return document.querySelector(`[${MODAL_POPUP_ATTR}][data-open], .MuiModal-root:not([aria-hidden="true"])`) !== null;
}

/**
 * Really on screen and focusable. Client rects are not enough: the closed, keep-mounted mobile
 * drawer is `visibility: hidden` — it still has rects, but `.focus()` on it silently does nothing.
 */
function isRegionShown(region: HTMLElement): boolean {
    if (region.getClientRects().length === 0 || region.closest('[aria-hidden="true"]')) {
        return false;
    }
    return getComputedStyle(region).visibility === 'visible';
}

export function visibleRegions(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(`[${KEYBOARD_REGION_ATTR}]`)).filter(isRegionShown);
}

// Regions focused by a keyboard command (F6). The container forwards such focus to an item even
// where the `:focus-visible` heuristic says no — WebKit reports programmatic focus after a mouse
// click as not focus-visible, which would park F6 on the bare container.
const keyboardEntries = new WeakSet<HTMLElement>();

export function focusRegionFromKeyboard(region: HTMLElement): void {
    keyboardEntries.add(region);
    try {
        // `focus()` dispatches the focus event synchronously, so the region's onFocus reads the flag before it is cleared.
        region.focus();
    } finally {
        keyboardEntries.delete(region);
    }
}

/** Whether focus that just landed on the container itself came from the keyboard (Tab, F6) — a mouse click on a gap must not move focus. */
export function isKeyboardEntry(region: HTMLElement): boolean {
    return keyboardEntries.has(region) || region.matches(':focus-visible');
}

/**
 * Shift+Tab from an item inside a region: the container (the region's one tab stop) would be the
 * next stop backwards, pausing the user on an empty box. Take it out of the tab order for the
 * duration of this one key — the browser moves focus after keydown — and put it back at once, so
 * nothing persists (a persisted -1 strands the region when its focused item unmounts) and nothing
 * re-renders (a state change on focus dropped clicks in a slow-rendering page).
 */
export function skipContainerOnShiftTab(region: HTMLElement, target: EventTarget | null): void {
    if (target === region) {
        return;
    }
    region.tabIndex = -1;
    setTimeout(() => {
        region.tabIndex = 0;
    });
}

/** A region's items in DOM order, skipping disabled ones (buttons via `disabled`, links and chips via `aria-disabled`). */
export function regionItems(region: HTMLElement): HTMLElement[] {
    return Array.from(region.querySelectorAll<HTMLElement>(`[${ROVING_ITEM_ATTR}]`)).filter(
        (item) => !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true',
    );
}
