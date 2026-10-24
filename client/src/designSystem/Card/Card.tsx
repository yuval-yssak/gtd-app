import { clsx } from 'clsx';
import type { ComponentProps } from 'react';
import styles from './Card.module.css';

type CardProps = ComponentProps<'div'> & {
    /** Inner padding: none (the caller lays out), sm (12px) or md (16px, MUI Paper p:2). */
    padding?: 'none' | 'sm' | 'md' | undefined;
    /** outline = hairline border (default); sunken = tinted fill without a border. */
    variant?: 'outline' | 'sunken' | undefined;
};

/** A surface that sets content apart from the page (MUI Paper). Flat: a hairline, never a shadow. */
export function Card({ padding = 'md', variant = 'outline', className, ...rest }: CardProps) {
    return <div data-padding={padding} data-variant={variant} {...rest} className={clsx(styles.card, className)} />;
}
