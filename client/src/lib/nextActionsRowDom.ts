import { ROW_ACTION_ATTR } from './rowShortcuts';

/**
 * DOM lookups the Next Actions row hooks share (drag + roving focus). Rows are found through the
 * data attributes every row carries, never through test ids. Not unit-tested (no jsdom here);
 * covered by the reorder and keyboard Playwright specs.
 */

/** Attributes every draggable row carries — the hooks read geometry and focus through them. */
export const ROW_SECTION_ATTR = 'data-section-key';
export const ROW_ITEM_ATTR = 'data-item-id';
/** The row's two focusable elements: the row button and the reorder handle. */
export const ROW_BUTTON_ATTR = 'data-row-button';
export const ROW_HANDLE_ATTR = 'data-row-handle';

/** How many frames to wait for virtua to mount a row that was just scrolled into its range. */
const MOUNT_WAIT_FRAMES = 12;

export function rowElement(itemId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[${ROW_ITEM_ATTR}="${CSS.escape(itemId)}"]`);
}

export function rowButtonOf(row: HTMLElement): HTMLElement | null {
    return row.querySelector<HTMLElement>(`[${ROW_BUTTON_ATTR}]`);
}

export function rowHandleOf(row: HTMLElement): HTMLElement | null {
    return row.querySelector<HTMLElement>(`[${ROW_HANDLE_ATTR}]`);
}

/** Marks a row button → / ← walk to (every button of a ranked row: the lettered ones and the rest, e.g. the Inbox's clarify buttons). */
export const ROW_WALK_ATTR = 'data-row-walk';

export function rowActionButtonsOf(row: HTMLElement): HTMLElement[] {
    return Array.from(row.querySelectorAll<HTMLElement>(`[${ROW_ACTION_ATTR}], [${ROW_WALK_ATTR}]`));
}

/** True when nothing else has taken focus: it is on the body (a moved/unmounted node dropped it) or still inside `row`. */
export function isFocusFree(row: HTMLElement): boolean {
    const active = document.activeElement;
    return active === null || active === document.body || row.contains(active);
}

/** The row an event target sits in, or null outside every row. */
export function rowOfTarget(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element ? target.closest<HTMLElement>(`[${ROW_ITEM_ATTR}]`) : null;
}

/**
 * Runs `onMounted` with the row once it is in the DOM — now, or within a few frames (virtua mounts
 * a row scrolled into its range asynchronously). Gives up silently: a row can vanish meanwhile.
 */
export function whenRowMounted(itemId: string, onMounted: (row: HTMLElement) => void, framesLeft = MOUNT_WAIT_FRAMES): void {
    const row = rowElement(itemId);
    if (row) {
        onMounted(row);
        return;
    }
    if (framesLeft > 0) {
        requestAnimationFrame(() => whenRowMounted(itemId, onMounted, framesLeft - 1));
    }
}
