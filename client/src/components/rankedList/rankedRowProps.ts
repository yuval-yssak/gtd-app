import { clsx } from 'clsx';
import type { RankedListApi } from '../../hooks/useRankedList';
import type { FlatRow, NextActionSection } from '../../lib/nextActionSections';
import { ROW_BUTTON_ATTR, ROW_ITEM_ATTR, ROW_SECTION_ATTR } from '../../lib/nextActionsRowDom';
import type { StoredItem } from '../../types/MyDB';
import styles from './RankedList.module.css';

/** One item row of a ranked list's flattened rows (headers excluded). */
export type ItemRow = Extract<FlatRow<StoredItem>, { kind: 'item' }>;

/**
 * Props for a ranked row's outer element: the drag state flags, the measured displacement, and the data
 * attributes the drag and the roving focus find rows through. The displacement is measured
 * geometry (the dragged row's own height), so it travels as a CSS variable the module's
 * `transform` reads; the pointer-dragged row itself is moved imperatively by the hook every frame,
 * so React leaves its variable alone. The literal is `DRAG_SHIFT_VAR` (typed through
 * `types/cssCustomProperties.d.ts`); keep the two in step.
 */
export function rankedRowProps(ranked: RankedListApi, row: ItemRow, className?: string) {
    const { item, section } = row;
    const { drag } = ranked;
    const isDragged = drag.drag?.itemId === item._id;
    const isPointerDragged = isDragged && !drag.drag?.isKeyboard;
    return {
        className: clsx(className, styles.rowShell),
        'data-dragging': isDragged || undefined,
        'data-shifted': (!isDragged && drag.drag !== null) || undefined,
        'data-dimmed': isOutsideActiveSection(ranked, section) || undefined,
        style: isPointerDragged ? undefined : { '--drag-shift': `${drag.shiftFor(item._id)}px` },
        [ROW_SECTION_ATTR]: section.key,
        [ROW_ITEM_ATTR]: item._id,
    };
}

/** Props for a ranked row's button (its ListRowButton body): its roving-focus wiring and its short screen-reader hint. */
export function rankedRowButtonProps(ranked: RankedListApi) {
    return { 'aria-describedby': ranked.hintIds.row, [ROW_BUTTON_ATTR]: '', ...ranked.roving.rowButtonProps };
}

/** Props for a section header row: flagged when overdue, dimmed while a drag is live in another section. */
export function rankedHeaderProps(ranked: RankedListApi, section: NextActionSection<StoredItem>) {
    return {
        className: styles.sectionHeader,
        'data-overdue': section.isOverdue || undefined,
        'data-dimmed': isOutsideActiveSection(ranked, section) || undefined,
    };
}

/** A drag is live in another section — the section wall dims this one. */
function isOutsideActiveSection({ drag }: RankedListApi, section: NextActionSection<StoredItem>) {
    return drag.drag !== null && drag.drag.sectionKey !== section.key;
}
