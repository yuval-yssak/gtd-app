import { Field } from '@base-ui/react/field';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import styles from './ChoiceLabel.module.css';

type ChoiceLabelProps = {
    /** The control (switch, checkbox, radio) — wrapped, so the label text names it. */
    control: ReactNode;
    label: ReactNode;
    /** Secondary line under the label. */
    description?: ReactNode | undefined;
    disabled?: boolean | undefined;
    /** Put the control after the text (settings rows). */
    placement?: 'start' | 'end' | undefined;
    /**
     * field = a standalone switch/checkbox (its own Field.Root); item = one radio inside a group
     * (a Field.Item, so each option keeps its own label).
     */
    scope?: 'field' | 'item' | undefined;
    className?: string | undefined;
    'data-testid'?: string | undefined;
};

/**
 * MUI FormControlLabel: a label that wraps, names and toggles its control — Base UI's documented
 * `Field.Label` pattern.
 */
export function ChoiceLabel({ control, label, description, disabled, placement = 'start', scope = 'field', className, ...rest }: ChoiceLabelProps) {
    const labelElement = (
        <Field.Label data-disabled={disabled || undefined} data-placement={placement} {...rest} className={clsx(styles.choiceLabel, className)}>
            {control}
            <span className={styles.text}>
                <span className={styles.label}>{label}</span>
                {description !== undefined && <span className={styles.description}>{description}</span>}
            </span>
        </Field.Label>
    );
    if (scope === 'item') return <Field.Item>{labelElement}</Field.Item>;
    return (
        <Field.Root disabled={disabled ?? false} className={styles.field}>
            {labelElement}
        </Field.Root>
    );
}
