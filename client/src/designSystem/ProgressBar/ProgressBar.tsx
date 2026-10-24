import { Progress } from '@base-ui/react/progress';
import { clsx } from 'clsx';
import styles from './ProgressBar.module.css';

type ProgressBarProps = {
    /** 0–100, or null for an indeterminate bar (MUI LinearProgress). */
    value: number | null;
    /** `span` keeps every part phrasing content, for a bar inside a button (MUI's bar was spans). */
    as?: 'div' | 'span' | undefined;
    'aria-label'?: string | undefined;
    className?: string | undefined;
    'data-testid'?: string | undefined;
};

/** A thin horizontal progress bar, `role="progressbar"`. */
export function ProgressBar({ value, as = 'div', className, ...rest }: ProgressBarProps) {
    const part = as === 'span' ? <span /> : undefined;
    return (
        <Progress.Root value={value} render={part} {...rest} className={clsx(styles.root, className)}>
            <Progress.Track render={part} className={styles.track}>
                <Progress.Indicator render={part} className={styles.indicator} />
            </Progress.Track>
        </Progress.Root>
    );
}
