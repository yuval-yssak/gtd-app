import { Separator as BaseSeparator } from '@base-ui/react/separator';
import { clsx } from 'clsx';
import styles from './Separator.module.css';

type SeparatorProps = {
    /** Spacing around the line comes from the caller's class. */
    className?: string | undefined;
};

/** A horizontal hairline divider (MUI Divider), `role="separator"`. */
export function Separator({ className }: SeparatorProps) {
    return <BaseSeparator className={clsx(styles.separator, className)} />;
}
