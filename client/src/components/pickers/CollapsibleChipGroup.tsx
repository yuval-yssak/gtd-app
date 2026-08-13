import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import type { SxProps, Theme } from '@mui/material/styles';
import { Fragment, useState } from 'react';
import { collapsePickerOptions, isPickerCollapsible } from '../../lib/collapsedPickerOptions';

interface CollapsibleChipGroupProps<T> {
    /** Usage-ranked order (most used first) — the collapsed view. */
    ranked: T[];
    /** A→Z order of the same options — the expanded view. */
    alphabetical: T[];
    /** Selected/assigned ids — kept visible even when ranked below the fold. */
    selectedIds: ReadonlySet<string>;
    keyOf: (option: T) => string;
    renderChip: (option: T) => React.ReactNode;
    /** Test id for the expander chips (`<testId>ShowMore` / `<testId>ShowFewer`). */
    testId: string;
    sx?: SxProps<Theme>;
}

/**
 * The shared chip-cloud container for context/person pickers and filter rows. Collapsed it shows
 * the top usage-ranked options plus a "+N more" chip; expanded it shows the full list A→Z with a
 * "Show fewer" chip. Chip appearance stays with the caller (each row has its own colors/icons) —
 * only the collapse behavior is centralized here.
 */
export function CollapsibleChipGroup<T>({ ranked, alphabetical, selectedIds, keyOf, renderChip, testId, sx }: CollapsibleChipGroupProps<T>) {
    const [expanded, setExpanded] = useState(false);
    const { visible, hiddenCount } = collapsePickerOptions({ ranked, alphabetical, selectedIds, keyOf, expanded });
    return (
        <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75, ...sx }}>
            {visible.map((option) => (
                <Fragment key={keyOf(option)}>{renderChip(option)}</Fragment>
            ))}
            {hiddenCount > 0 && (
                <Chip label={`+${hiddenCount} more`} size="small" variant="outlined" onClick={() => setExpanded(true)} data-testid={`${testId}ShowMore`} />
            )}
            {/* Gate on collapsibility, not just `expanded`: a live-faceted list can shrink below the
                fold threshold while expanded, making "Show fewer" a dead no-op chip. */}
            {expanded && isPickerCollapsible(ranked.length) && (
                <Chip label="Show fewer" size="small" variant="outlined" onClick={() => setExpanded(false)} data-testid={`${testId}ShowFewer`} />
            )}
        </Stack>
    );
}
