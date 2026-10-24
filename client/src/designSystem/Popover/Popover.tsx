import { Popover as BasePopover } from '@base-ui/react/popover';
import { clsx } from 'clsx';
import type { ComponentProps, ReactNode, RefObject } from 'react';
import { MODAL_POPUP_ATTR } from '../../lib/keyboardRegionDom';
import styles from './Popover.module.css';

type PopoverProps = {
    open: boolean;
    onClose: () => void;
    /** What the panel hangs off (MUI `anchorEl`). */
    anchor: Element | RefObject<Element | null> | null;
    side?: ComponentProps<typeof BasePopover.Positioner>['side'] | undefined;
    align?: ComponentProps<typeof BasePopover.Positioner>['align'] | undefined;
    /** Element to focus on open; defaults to the first tabbable element. */
    initialFocus?: RefObject<HTMLElement | null> | undefined;
    children: ReactNode;
    className?: string | undefined;
    'aria-label'?: string | undefined;
    'data-testid'?: string | undefined;
};

/**
 * A floating panel anchored to an element, opened by state rather than by a trigger part (MUI
 * Popover). Modal like MUI's: focus is trapped and an outside press or Escape closes it.
 */
export function Popover({ open, onClose, anchor, side = 'bottom', align = 'start', initialFocus, className, children, ...rest }: PopoverProps) {
    return (
        <BasePopover.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()} modal>
            <BasePopover.Portal>
                <BasePopover.Positioner anchor={anchor} side={side} align={align} sideOffset={4} collisionPadding={8} className={styles.positioner}>
                    <BasePopover.Popup
                        {...{ [MODAL_POPUP_ATTR]: '' }}
                        {...(initialFocus ? { initialFocus } : {})}
                        {...rest}
                        className={clsx(styles.popup, className)}
                    >
                        {children}
                    </BasePopover.Popup>
                </BasePopover.Positioner>
            </BasePopover.Portal>
        </BasePopover.Root>
    );
}
