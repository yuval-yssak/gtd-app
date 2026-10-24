import type { ReactNode } from 'react';
import { Text } from '../../designSystem';
import styles from './FieldSection.module.css';

interface FieldSectionProps {
    /** The caption above the controls; as the legend it also names the group for assistive tech. */
    label: string;
    className?: string | undefined;
    children: ReactNode;
}

/** A captioned group of form controls (chip clouds, toggle groups) that have no label of their own. */
export function FieldSection({ label, className, children }: FieldSectionProps) {
    return (
        <fieldset className={className}>
            <Text as="legend" variant="caption" tone="secondary" className={styles.label}>
                {label}
            </Text>
            <div className={styles.controls}>{children}</div>
        </fieldset>
    );
}
