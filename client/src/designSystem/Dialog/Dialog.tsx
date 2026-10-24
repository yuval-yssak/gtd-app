import { AlertDialog as BaseAlertDialog } from '@base-ui/react/alert-dialog';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { clsx } from 'clsx';
import { type ComponentProps, type ReactNode, type RefObject, useRef } from 'react';
import { MODAL_POPUP_ATTR } from '../../lib/keyboardRegionDom';
import styles from './Dialog.module.css';

export type DialogCloseReason = 'escapeKey' | 'backdropClick' | 'closeButton' | 'other';

const REASON_BY_BASE_UI: Record<string, DialogCloseReason> = {
    'escape-key': 'escapeKey',
    'outside-press': 'backdropClick',
    'close-press': 'closeButton',
};

type SharedDialogProps = {
    open: boolean;
    /** Escape, backdrop press (Dialog only) or a `DialogClose` part asked to close. */
    onClose?: ((reason: DialogCloseReason) => void) | undefined;
    /** Max width: xs ≈ 28rem, sm ≈ 37.5rem, md ≈ 56rem — MUI's maxWidth steps. */
    size?: 'xs' | 'sm' | 'md' | undefined;
    /** Take the full `size` width instead of shrinking to the content. */
    fullWidth?: boolean | undefined;
    /** Element to focus on open; defaults to the first tabbable element. */
    initialFocus?: RefObject<HTMLElement | null> | undefined;
    className?: string | undefined;
    children: ReactNode;
    'data-testid'?: string | undefined;
    'aria-label'?: string | undefined;
    'aria-describedby'?: string | undefined;
};

type DialogProps = SharedDialogProps & {
    /** Keep the dialog open on a backdrop press (it still closes on Escape). */
    disableBackdropClose?: boolean | undefined;
};

/** Centred modal card, the same on every screen size. Names itself from `DialogTitle`. */
export function Dialog({ open, onClose, disableBackdropClose, ...popupProps }: DialogProps) {
    return (
        <BaseDialog.Root open={open} onOpenChange={toOpenChange(onClose)} disablePointerDismissal={disableBackdropClose ?? false}>
            <DialogSurface {...popupProps} />
        </BaseDialog.Root>
    );
}

/**
 * A confirmation that needs an explicit answer: `role="alertdialog"`, closes on Escape but never on
 * a backdrop press. Opens with focus on the dialog itself (as MUI did), not its first button — Enter
 * must never confirm a destructive action the user has not looked at.
 */
export function AlertDialog({ open, onClose, ...popupProps }: SharedDialogProps) {
    return (
        <BaseAlertDialog.Root open={open} onOpenChange={toOpenChange(onClose)}>
            <DialogSurface isPopupFocusedFirst {...popupProps} />
        </BaseAlertDialog.Root>
    );
}

function toOpenChange(onClose: SharedDialogProps['onClose']) {
    return (isOpen: boolean, details: { reason: string }) => {
        if (!isOpen) onClose?.(REASON_BY_BASE_UI[details.reason] ?? 'other');
    };
}

// Backdrop + viewport + popup; the Base UI Dialog and AlertDialog share these parts.
function DialogSurface({
    size = 'sm',
    fullWidth,
    initialFocus,
    isPopupFocusedFirst,
    className,
    children,
    ...rest
}: Omit<SharedDialogProps, 'open' | 'onClose'> & { isPopupFocusedFirst?: boolean | undefined }) {
    const popupRef = useRef<HTMLDivElement | null>(null);
    const focusTarget = initialFocus ?? (isPopupFocusedFirst ? popupRef : undefined);
    return (
        <BaseDialog.Portal>
            <BaseDialog.Backdrop className={styles.backdrop} />
            <BaseDialog.Viewport className={styles.viewport}>
                <BaseDialog.Popup
                    {...{ [MODAL_POPUP_ATTR]: '' }}
                    data-size={size}
                    data-full-width={fullWidth || undefined}
                    ref={popupRef}
                    {...(focusTarget ? { initialFocus: focusTarget } : {})}
                    {...rest}
                    className={clsx(styles.popup, className)}
                >
                    {children}
                </BaseDialog.Popup>
            </BaseDialog.Viewport>
        </BaseDialog.Portal>
    );
}

export function DialogTitle({ className, ...rest }: Omit<ComponentProps<'h2'>, 'className'> & { className?: string | undefined }) {
    return <BaseDialog.Title {...rest} className={clsx(styles.title, className)} />;
}

/** The dialog's descriptive paragraph (MUI DialogContentText); announced with the title. */
export function DialogDescription({ className, ...rest }: Omit<ComponentProps<'p'>, 'className'> & { className?: string | undefined }) {
    return <BaseDialog.Description {...rest} className={clsx(styles.description, className)} />;
}

/** The scrolling body between the title and the actions. */
export function DialogContent({ className, ...rest }: ComponentProps<'div'>) {
    return <div {...rest} className={clsx(styles.content, className)} />;
}

export function DialogActions({ className, ...rest }: ComponentProps<'div'>) {
    return <div {...rest} className={clsx(styles.actions, className)} />;
}

/** Wraps a button so pressing it closes the dialog through `onClose('closeButton')`. */
export function DialogClose({ render }: { render: ComponentProps<typeof BaseDialog.Close>['render'] }) {
    return <BaseDialog.Close render={render} />;
}
