import { Drawer as BaseDrawer } from '@base-ui/react/drawer';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { MODAL_POPUP_ATTR } from '../../lib/keyboardRegionDom';
import styles from './Drawer.module.css';

type DrawerProps = {
    open: boolean;
    onClose: () => void;
    /** start = the mobile nav panel; bottom = a sheet (swipe down to dismiss). */
    side?: 'start' | 'bottom' | undefined;
    /** Visible heading; it names the drawer. Without it pass `aria-label`. */
    title?: ReactNode | undefined;
    'aria-label'?: string | undefined;
    children: ReactNode;
    className?: string | undefined;
    'data-testid'?: string | undefined;
};

/**
 * A modal panel that slides in from an edge and swipes away (MUI Drawer / SwipeableDrawer).
 * Unmounted while closed — never keep-mounted, so a closed drawer's keyboard region leaves the DOM
 * and `isModalOpen()` can trust presence.
 */
export function Drawer({ open, onClose, side = 'start', title, children, className, ...rest }: DrawerProps) {
    return (
        <BaseDrawer.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()} swipeDirection={side === 'bottom' ? 'down' : 'left'}>
            <BaseDrawer.Portal>
                <BaseDrawer.Backdrop className={styles.backdrop} />
                <BaseDrawer.Viewport className={styles.viewport} data-side={side}>
                    <BaseDrawer.Popup {...{ [MODAL_POPUP_ATTR]: '' }} data-side={side} {...rest} className={clsx(styles.popup, className)}>
                        {side === 'bottom' && <div className={styles.handle} aria-hidden="true" />}
                        <BaseDrawer.Content className={styles.content}>
                            {title !== undefined && <BaseDrawer.Title className={styles.title}>{title}</BaseDrawer.Title>}
                            {children}
                        </BaseDrawer.Content>
                    </BaseDrawer.Popup>
                </BaseDrawer.Viewport>
            </BaseDrawer.Portal>
        </BaseDrawer.Root>
    );
}
