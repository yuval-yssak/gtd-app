import { clsx } from 'clsx';
import type { ComponentProps } from 'react';
import styles from './Card.module.css';

type CardProps = ComponentProps<'div'> & {
    /** Inner padding: none (the caller lays out), sm (12px) or md (16px, MUI Paper p:2). */
    padding?: 'none' | 'sm' | 'md' | undefined;
};

/** A surface that sets content apart from the page (MUI Paper). Flat: a hairline, never a shadow. */
export function Card({ padding = 'md', className, ...rest }: CardProps) {
    return <div data-padding={padding} {...rest} className={clsx(styles.card, className)} />;
}
