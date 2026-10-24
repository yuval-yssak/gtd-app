import { clsx } from 'clsx';
import { Fragment, type ReactNode, useState } from 'react';
import { Chip } from '../../designSystem';
import { collapsePickerOptions, isPickerCollapsible } from '../../lib/collapsedPickerOptions';
import styles from './CollapsibleChipGroup.module.css';

interface CollapsibleChipGroupProps<T> {
    /** Usage-ranked order (most used first) — the collapsed view. */
    ranked: T[];
    /** A→Z order of the same options — the expanded view. */
    alphabetical: T[];
    /** Selected/assigned ids — kept visible even when ranked below the fold. */
    selectedIds: ReadonlySet<string>;
    keyOf: (option: T) => string;
    renderChip: (option: T) => ReactNode;
    /** Test id for the expander chips (`<testId>ShowMore` / `<testId>ShowFewer`). */
    testId: string;
    className?: string | undefined;
    /** Extra props for the "+N more" / "Show fewer" chips — a keyboard region takes them out of the tab order. */
    expanderChipProps?: ({ tabIndex?: number } & Record<`data-${string}`, string>) | undefined;
}

/**
 * The shared chip-cloud container for context/person pickers and filter rows. Collapsed it shows
 * the top usage-ranked options plus a "+N more" chip; expanded it shows the full list A→Z with a
 * "Show fewer" chip. Chip appearance stays with the caller (each row has its own colors/icons) —
 * only the collapse behavior is centralized here.
 */
export function CollapsibleChipGroup<T>({
    ranked,
    alphabetical,
    selectedIds,
    keyOf,
    renderChip,
    testId,
    className,
    expanderChipProps,
}: CollapsibleChipGroupProps<T>) {
    const [expanded, setExpanded] = useState(false);
    const { visible, hiddenCount } = collapsePickerOptions({ ranked, alphabetical, selectedIds, keyOf, expanded });
    return (
        <div className={clsx(styles.group, className)}>
            {visible.map((option) => (
                <Fragment key={keyOf(option)}>{renderChip(option)}</Fragment>
            ))}
            {hiddenCount > 0 && (
                <Chip
                    label={`+${hiddenCount} more`}
                    size="sm"
                    variant="outline"
                    onClick={() => setExpanded(true)}
                    data-testid={`${testId}ShowMore`}
                    {...expanderChipProps}
                />
            )}
            {/* Gate on collapsibility, not just `expanded`: a live-faceted list can shrink below the
                fold threshold while expanded, making "Show fewer" a dead no-op chip. */}
            {expanded && isPickerCollapsible(ranked.length) && (
                <Chip
                    label="Show fewer"
                    size="sm"
                    variant="outline"
                    onClick={() => setExpanded(false)}
                    data-testid={`${testId}ShowFewer`}
                    {...expanderChipProps}
                />
            )}
        </div>
    );
}
