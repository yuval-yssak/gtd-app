import { clsx } from 'clsx';
import type { ComponentProps, ReactNode } from 'react';
import styles from './Callout.module.css';

export type CalloutTone = 'info' | 'success' | 'warning' | 'error';

type CalloutProps = Omit<ComponentProps<'div'>, 'title'> & {
    tone?: CalloutTone | undefined;
    title?: ReactNode | undefined;
    /** Buttons on the trailing edge. */
    action?: ReactNode | undefined;
    /** Adds a close button. */
    onClose?: (() => void) | undefined;
    /** soft = tinted fill (MUI standard), outline = MUI outlined. */
    variant?: 'soft' | 'outline' | undefined;
};

const ICON_PATH: Record<CalloutTone, string> = {
    info: 'M8 7v4M8 5h.01M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z',
    success: 'M5 8.5l2 2 4-4.5M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z',
    warning: 'M8 6v3M8 11h.01M7.1 2.6L1.7 12a1 1 0 0 0 .9 1.5h10.8a1 1 0 0 0 .9-1.5L8.9 2.6a1 1 0 0 0-1.8 0z',
    error: 'M8 5v3.5M8 11h.01M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z',
};

/**
 * An inline notice (MUI Alert). Errors and warnings are `role="alert"` (announced at once, as MUI
 * did); info and success are `role="status"`.
 */
export function Callout({ tone = 'info', title, action, onClose, variant = 'soft', className, children, ...rest }: CalloutProps) {
    return (
        <div
            role={tone === 'error' || tone === 'warning' ? 'alert' : 'status'}
            data-tone={tone}
            data-variant={variant}
            {...rest}
            className={clsx(styles.callout, className)}
        >
            <svg viewBox="0 0 16 16" aria-hidden="true" className={styles.icon}>
                <path d={ICON_PATH[tone]} />
            </svg>
            <div className={styles.body}>
                {title !== undefined && <div className={styles.title}>{title}</div>}
                {children}
            </div>
            {action !== undefined && <div className={styles.action}>{action}</div>}
            {onClose && (
                <button type="button" aria-label="Close" className={styles.close} onClick={onClose}>
                    <svg viewBox="0 0 16 16" aria-hidden="true" className={styles.closeGlyph}>
                        <path d="M4.5 4.5l7 7m0-7l-7 7" />
                    </svg>
                </button>
            )}
        </div>
    );
}
