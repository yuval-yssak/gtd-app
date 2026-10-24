import { clsx } from 'clsx';
import type { ComponentProps } from 'react';
import styles from './Spinner.module.css';

type SpinnerProps = Omit<ComponentProps<'span'>, 'children'> & {
    /** Diameter in px (the MUI `CircularProgress size` it replaces). */
    size?: number | undefined;
    tone?: 'accent' | 'inherit' | undefined;
    /** Announced name; defaults to "Loading". */
    label?: string | undefined;
};

/** Indeterminate progress. Renders `role="progressbar"`, as MUI's CircularProgress did. */
export function Spinner({ size = 24, tone = 'accent', label = 'Loading', className, style, ...rest }: SpinnerProps) {
    // The diameter is a per-call number, so it is passed as a custom property rather than a class.
    const sizeStyle = { '--spinner-size': `${size / 16}rem`, ...style };
    return (
        <span role="progressbar" aria-label={label} data-tone={tone} {...rest} style={sizeStyle} className={clsx(styles.spinner, className)}>
            <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.svg}>
                <circle cx="12" cy="12" r="9.5" className={styles.track} />
                <circle cx="12" cy="12" r="9.5" className={styles.arc} />
            </svg>
        </span>
    );
}
