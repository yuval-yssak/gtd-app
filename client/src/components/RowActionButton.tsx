import type { ReactNode } from 'react';
import { IconButton, type IconButtonProps, Tooltip } from '../designSystem';
import { ROW_ACTION_KEYS, type RowActionName, rowActionButtonProps, withShortcutHint } from '../lib/rowShortcuts';

interface RowActionButtonProps extends Omit<IconButtonProps, 'aria-label' | 'children'> {
    /** The row action a letter presses — the key in the tooltip and `aria-keyshortcuts` come from it, so they cannot drift apart. */
    rowAction: RowActionName;
    /** The button's name ("Edit"). The tooltip adds the key ("Edit (e)"); the accessible name stays the label — the key is announced from `aria-keyshortcuts`. */
    label: string;
    icon: ReactNode;
}

/** A list row's icon button that a letter shortcut presses (see `rowShortcuts.ts`), teaching its key in its tooltip. */
export function RowActionButton({ rowAction, label, icon, ...buttonProps }: RowActionButtonProps) {
    return (
        <Tooltip title={withShortcutHint(label, ROW_ACTION_KEYS[rowAction])}>
            <IconButton size="sm" aria-label={label} {...rowActionButtonProps(rowAction)} {...buttonProps}>
                {icon}
            </IconButton>
        </Tooltip>
    );
}
