import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import styles from './Badge.module.css';

type BadgeProps = {
    /** The count; hidden when 0 unless `showZero`. */
    count: number;
    /** Cap the shown number (MUI `max`, default 99 → "99+"). */
    max?: number | undefined;
    showZero?: boolean | undefined;
    tone?: 'accent' | 'error' | 'warning' | 'neutral' | undefined;
    /** The element the badge sits on; without it the badge renders inline. */
    children?: ReactNode | undefined;
    className?: string | undefined;
    'data-testid'?: string | undefined;
};

/** A count bubble (MUI Badge). */
export function Badge({ count, max = 99, showZero, tone = 'accent', children, className, ...rest }: BadgeProps) {
    const isHidden = count === 0 && !showZero;
    const bubble = isHidden ? null : (
        <span data-tone={tone} data-anchored={children === undefined ? undefined : ''} className={styles.bubble} {...rest}>
            {count > max ? `${max}+` : count}
        </span>
    );
    if (children === undefined) return bubble;
    return (
        <span className={clsx(styles.anchor, className)}>
            {children}
            {bubble}
        </span>
    );
}
