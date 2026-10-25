import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import styles from './Badge.module.css';

// MUI Badge's default `max`: anything above shows as "99+".
const MAX_SHOWN_COUNT = 99;

type BadgeProps = {
    /** The count; hidden when 0. */
    count: number;
    tone?: 'accent' | 'error' | 'warning' | 'neutral' | undefined;
    /** The element the badge sits on; without it the badge renders inline. */
    children?: ReactNode | undefined;
    /** On the anchor wrapper when the badge sits on `children`, else on the bubble itself. */
    className?: string | undefined;
    'data-testid'?: string | undefined;
};

/** A count bubble (MUI Badge). */
export function Badge({ count, tone = 'accent', children, className, ...rest }: BadgeProps) {
    const isInline = children === undefined;
    const bubble =
        count === 0 ? null : (
            <span data-tone={tone} data-anchored={isInline ? undefined : ''} {...rest} className={clsx(styles.bubble, isInline && className)}>
                {count > MAX_SHOWN_COUNT ? `${MAX_SHOWN_COUNT}+` : count}
            </span>
        );
    if (isInline) {
        return bubble;
    }
    return (
        <span className={clsx(styles.anchor, className)}>
            {children}
            {bubble}
        </span>
    );
}
