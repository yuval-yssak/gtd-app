import { GripVertical } from 'lucide-react';
import { IconButton } from '../../designSystem';
import type { RankedListApi } from '../../hooks/useRankedList';
import type { NextActionSection } from '../../lib/nextActionSections';
import { ROW_HANDLE_ATTR } from '../../lib/nextActionsRowDom';
import type { StoredItem } from '../../types/MyDB';
import styles from './RankedList.module.css';

/** A contextmenu raised by a touch long press (Chrome/Android dispatch it as a PointerEvent); a mouse right-click is not. */
function isTouchContextMenu(event: Event): boolean {
    return 'pointerType' in event && event.pointerType === 'touch';
}

interface Props {
    ranked: RankedListApi;
    item: StoredItem;
    section: NextActionSection<StoredItem>;
    testId: string;
}

/**
 * The leading reorder handle — a real button beside (not inside) the row button: nested interactive
 * content is invalid ARIA, and the row's click would fire on every drop. Pages render none for a
 * ghost (a row fading out of the list is not a drag source).
 */
export function RankedRowHandle({ ranked, item, section, testId }: Props) {
    return (
        <IconButton
            size="sm"
            className={styles.dragHandle}
            aria-label="Reorder"
            aria-describedby={ranked.hintIds.list}
            data-testid={testId}
            // Out of the tab order (Space on the row grabs too); still focusable by click.
            tabIndex={-1}
            {...{ [ROW_HANDLE_ATTR]: '' }}
            {...ranked.drag.getHandleProps(item, section)}
            // Right-click on the handle is the mouse way to the "Move to…" sheet. A touch long press
            // already drags (and fires contextmenu mid-press), so the gesture is told apart by its
            // pointer type, not by the device: a touch laptop has both.
            onContextMenu={(e) => {
                e.preventDefault();
                if (!isTouchContextMenu(e.nativeEvent)) {
                    ranked.openMoveTo(item, section);
                }
            }}
        >
            <GripVertical />
        </IconButton>
    );
}
