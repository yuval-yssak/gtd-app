/**
 * Collapse policy shared by every context/person chip row (next-actions filters, item/routine
 * editors, search filters): collapsed rows show the top `limit` usage-ranked options plus any
 * selected stragglers; expanded rows show everything alphabetically (scanning a long list is a
 * lookup-by-name task, where A→Z beats usage order).
 */

/** Collapsed rows show this many usage-ranked options before folding the tail behind "+N more". */
export const PICKER_COLLAPSE_LIMIT = 8;

/** A tail this short isn't worth a "+N more" chip — show up to limit+slack options uncollapsed. */
const PICKER_COLLAPSE_SLACK = 2;

/** Whether a list of this size collapses at all. Drives both the fold and the "Show fewer" chip —
 *  a live-faceted list can shrink below the threshold while expanded, at which point collapsing
 *  is a no-op and the chip must disappear. */
export const isPickerCollapsible = (optionCount: number) => optionCount > PICKER_COLLAPSE_LIMIT + PICKER_COLLAPSE_SLACK;

interface CollapseArgs<T> {
    /** Usage-ranked order (most used first) — the collapsed view's order. */
    ranked: T[];
    /** A→Z order of the same options — the expanded view's order. */
    alphabetical: T[];
    /** Currently selected/assigned ids — always visible even when ranked outside the top slice. */
    selectedIds: ReadonlySet<string>;
    keyOf: (option: T) => string;
    expanded: boolean;
}

export interface CollapsedOptions<T> {
    visible: T[];
    /** Options folded behind the "+N more" chip; 0 ⇒ no expander rendered. */
    hiddenCount: number;
}

export function collapsePickerOptions<T>({ ranked, alphabetical, selectedIds, keyOf, expanded }: CollapseArgs<T>): CollapsedOptions<T> {
    // Usage order only governs the collapsed top slice — whenever the full list is shown
    // (expanded, or short enough not to collapse), A→Z keeps it scannable and stable.
    if (expanded || !isPickerCollapsible(ranked.length)) {
        return { visible: alphabetical, hiddenCount: 0 };
    }
    const topKeys = new Set(ranked.slice(0, PICKER_COLLAPSE_LIMIT).map(keyOf));
    const visible = ranked.filter((option) => topKeys.has(keyOf(option)) || selectedIds.has(keyOf(option)));
    return { visible, hiddenCount: ranked.length - visible.length };
}
