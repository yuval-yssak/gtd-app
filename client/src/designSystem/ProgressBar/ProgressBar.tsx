import { Progress } from '@base-ui/react/progress';
import { clsx } from 'clsx';
import styles from './ProgressBar.module.css';

type ProgressBarProps = {
    /** 0–100, or null for an indeterminate bar (MUI LinearProgress). */
    value: number | null;
    'aria-label'?: string | undefined;
    className?: string | undefined;
    'data-testid'?: string | undefined;
};

/** A thin horizontal progress bar, `role="progressbar"`. */
export function ProgressBar({ value, className, ...rest }: ProgressBarProps) {
    return (
        <Progress.Root value={value} {...rest} className={clsx(styles.root, className)}>
            <Progress.Track className={styles.track}>
                <Progress.Indicator className={styles.indicator} />
            </Progress.Track>
        </Progress.Root>
    );
}
