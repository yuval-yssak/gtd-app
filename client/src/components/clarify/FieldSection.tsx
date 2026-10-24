import type { ReactNode } from 'react';
import { Text } from '../../designSystem';
import styles from './FieldSection.module.css';

interface FieldSectionProps {
    /** The caption above the controls; as the legend it also names the group for assistive tech. */
    label: string;
    /**
     * Locks the section through the native fieldset, so its native controls are disabled for the
     * keyboard too. Span-rendered DS controls (Radio, Checkbox, Switch) are not reached by it —
     * pass `disabled` to those as well.
     */
    disabled?: boolean | undefined;
    className?: string | undefined;
    children: ReactNode;
}

/** A captioned group of form controls (chip clouds, toggle groups) that have no label of their own. */
export function FieldSection({ label, disabled, className, children }: FieldSectionProps) {
    return (
        // The controls draw their own disabled look; dimming the fieldset too would fade them twice.
        <fieldset className={className} disabled={disabled}>
            <Text as="legend" variant="caption" tone="secondary" className={styles.label}>
                {label}
            </Text>
            <div className={styles.controls}>{children}</div>
        </fieldset>
    );
}
