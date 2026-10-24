import { clsx } from 'clsx';
import { type FocusEvent, type ReactNode, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './Toast.module.css';

export type ToastCloseReason = 'timeout' | 'closeButton';

type ToastProps = {
    open: boolean;
    message: ReactNode;
    /** Buttons beside the message (Undo, View). */
    action?: ReactNode | undefined;
    /** Auto-dismiss after this many ms; the timer pauses while the pointer or focus is on the toast. */
    autoHideDuration?: number | undefined;
    onClose?: ((reason: ToastCloseReason) => void) | undefined;
    /** `error` is also announced assertively (`role="alert"`); everything else through the polite region. */
    tone?: 'neutral' | 'error' | 'success' | undefined;
    /** Show a close (×) button. */
    dismissible?: boolean | undefined;
    className?: string | undefined;
    'data-testid'?: string | undefined;
};

const REGION_ID = 'gtd-toast-region';

/**
 * The one shared stacking region — a persistent polite live region, so a toast is announced as
 * content arriving in an existing region (screen readers skip live regions that arrive already
 * filled). Not Base UI's Toast: its viewport takes over F6 globally while a toast is visible, which
 * would steal the app's F6 region cycling.
 */
export function ensureToastRegion() {
    const existing = document.getElementById(REGION_ID);
    if (existing) return existing;
    const region = document.createElement('div');
    region.id = REGION_ID;
    region.setAttribute('role', 'status');
    region.className = styles.region ?? '';
    document.body.append(region);
    return region;
}

/** The region, created after mount — never during render. */
function useToastRegion() {
    const [region, setRegion] = useState<HTMLElement | null>(null);
    useLayoutEffect(() => setRegion(ensureToastRegion()), []);
    return region;
}

/** A transient notice (MUI Snackbar's declarative shape: `open` + `message` + `onClose`). */
export function Toast({ open, ...bodyProps }: ToastProps) {
    const region = useToastRegion();
    if (!open || !region) return null;
    return createPortal(<ToastBody {...bodyProps} />, region);
}

// Mounted only while open, so the pause latch and the timer are born and die with each showing: a
// toast closed under the pointer (Undo, ×) never receives the pointerleave that would unpause it.
function ToastBody({ message, action, autoHideDuration, onClose, tone = 'neutral', dismissible, className, ...rest }: Omit<ToastProps, 'open'>) {
    const pause = useHoverOrFocusPause();
    useAutoHide(!pause.isPaused, autoHideDuration, onClose);
    return (
        <div role={tone === 'error' ? 'alert' : undefined} data-tone={tone} {...pause.handlers} {...rest} className={clsx(styles.toast, className)}>
            <div className={styles.message}>{message}</div>
            {action !== undefined && <div className={styles.action}>{action}</div>}
            {dismissible && (
                <button type="button" aria-label="Close" className={styles.close} onClick={() => onClose?.('closeButton')}>
                    <span aria-hidden="true">×</span>
                </button>
            )}
        </div>
    );
}

function useAutoHide(isRunning: boolean, duration: number | undefined, onClose: ToastProps['onClose']) {
    const onTimeout = useEffectEvent(() => onClose?.('timeout'));
    useEffect(() => {
        if (!isRunning || duration === undefined) return;
        const timer = window.setTimeout(onTimeout, duration);
        return () => window.clearTimeout(timer);
    }, [isRunning, duration]);
}

// Pausing restarts the full duration on resume (MUI's behaviour), so a user reading the message
// or reaching for Undo never loses it mid-way.
function useHoverOrFocusPause() {
    const [isPaused, setIsPaused] = useState(false);
    const isFocusInside = useRef(false);
    const isPointerInside = useRef(false);
    const update = () => setIsPaused(isFocusInside.current || isPointerInside.current);
    return {
        isPaused,
        handlers: {
            onPointerEnter: () => {
                isPointerInside.current = true;
                update();
            },
            onPointerLeave: () => {
                isPointerInside.current = false;
                update();
            },
            onFocus: () => {
                isFocusInside.current = true;
                update();
            },
            onBlur: (event: FocusEvent<HTMLDivElement>) => {
                isFocusInside.current = event.currentTarget.contains(event.relatedTarget);
                update();
            },
        },
    };
}
