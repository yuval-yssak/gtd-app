import { Separator as BaseSeparator } from '@base-ui/react/separator';
import { clsx } from 'clsx';
import styles from './Separator.module.css';

type SeparatorProps = {
    orientation?: 'horizontal' | 'vertical' | undefined;
    /** Space around the line (MUI Divider margins): none, sm (8px) or md (16px). */
    spacing?: 'none' | 'sm' | 'md' | undefined;
    className?: string | undefined;
};

/** A hairline divider (MUI Divider), `role="separator"`. */
export function Separator({ orientation = 'horizontal', spacing = 'none', className }: SeparatorProps) {
    return <BaseSeparator orientation={orientation} data-spacing={spacing} className={clsx(styles.separator, className)} />;
}
