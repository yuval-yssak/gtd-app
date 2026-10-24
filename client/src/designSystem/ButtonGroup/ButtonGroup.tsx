import { clsx } from 'clsx';
import type { ComponentProps } from 'react';
import styles from './ButtonGroup.module.css';

/**
 * Joins adjacent DS `Button`s into one segmented row (MUI ButtonGroup). A `<fieldset>`, so it is a
 * named group: give it an `aria-label`. Note that `disabled` on a fieldset disables every button in
 * it. Children keep their own `title`s — a Tooltip wrapper would break the joined borders.
 */
export function ButtonGroup({ className, ...rest }: ComponentProps<'fieldset'>) {
    return <fieldset {...rest} className={clsx(styles.group, className)} />;
}
