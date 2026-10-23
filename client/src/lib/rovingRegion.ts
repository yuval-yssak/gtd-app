/**
 * Pure helpers behind the keyboard "regions" (sidebar menu, account avatars, filter bar, list):
 * each region is ONE tab stop, arrows move inside it, F6 / Shift+F6 hop between regions. The DOM
 * glue lives in `hooks/useRovingRegion.ts` and `hooks/useGlobalShortcuts.ts`.
 */

/** Which arrow keys walk a region: a vertical menu (↑/↓), a horizontal toolbar (←/→), or a wrapping chip cloud (all four, linear). */
export type RovingOrientation = 'vertical' | 'horizontal' | 'both';

const PREVIOUS_KEYS: Record<RovingOrientation, readonly string[]> = {
    vertical: ['ArrowUp'],
    horizontal: ['ArrowLeft'],
    both: ['ArrowUp', 'ArrowLeft'],
};
const NEXT_KEYS: Record<RovingOrientation, readonly string[]> = {
    vertical: ['ArrowDown'],
    horizontal: ['ArrowRight'],
    both: ['ArrowDown', 'ArrowRight'],
};

/**
 * The item index a key moves to inside a region of `count` items, or null when the key is not a
 * walking key (or the region is empty). Clamps at the ends — a menu that wraps from the last item
 * to the first reads as a jump the user did not ask for. `current` is -1 while focus is parked on
 * the region's container: a "next" key or Home steps onto the first item, a "previous" key or End
 * onto the last (as on the Next Actions list's container).
 */
export function nextRovingIndex(count: number, current: number, key: string, orientation: RovingOrientation): number | null {
    const step = PREVIOUS_KEYS[orientation].includes(key) ? -1 : NEXT_KEYS[orientation].includes(key) ? 1 : 0;
    if (count === 0 || (step === 0 && key !== 'Home' && key !== 'End')) {
        return null;
    }
    if (key === 'End' || (current < 0 && step < 0)) {
        return count - 1;
    }
    if (key === 'Home' || current < 0) {
        return 0;
    }
    return Math.min(Math.max(current + step, 0), count - 1);
}

/** F6 / Shift+F6: the region after (or before) `current`, wrapping — region cycling is a loop, unlike walking a menu. -1 = focus is in no region. */
export function nextRegionIndex(count: number, current: number, delta: 1 | -1): number | null {
    if (count === 0) {
        return null;
    }
    if (current < 0) {
        return delta === 1 ? 0 : count - 1;
    }
    return (current + delta + count) % count;
}
