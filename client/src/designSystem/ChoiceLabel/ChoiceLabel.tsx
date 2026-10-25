import { Field } from '@base-ui/react/field';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import styles from './ChoiceLabel.module.css';

type ChoiceLabelProps = {
    /** The control (switch, checkbox, radio) — wrapped, so the label text names it. */
    control: ReactNode;
    label: ReactNode;
    /** Secondary line under the label: describes the control (aria-describedby), never part of its name. */
    description?: ReactNode | undefined;
    disabled?: boolean | undefined;
    /**
     * field = a standalone switch/checkbox (its own Field.Root); item = one radio inside a group
     * (a Field.Item, so each option keeps its own label and description).
     */
    scope?: 'field' | 'item' | undefined;
    className?: string | undefined;
    'data-testid'?: string | undefined;
};

/**
 * MUI FormControlLabel: a label that wraps, names and toggles its control — Base UI's documented
 * `Field.Label` pattern. The description sits outside the label, as a `Field.Description`: inside
 * it, its text would run straight into the control's accessible name.
 */
export function ChoiceLabel({ control, label, description, disabled, scope = 'field', className, ...rest }: ChoiceLabelProps) {
    const content = (
        <>
            <Field.Label data-disabled={disabled || undefined} {...rest} className={clsx(styles.choiceLabel, className)}>
                {control}
                <span className={styles.label}>{label}</span>
            </Field.Label>
            {description !== undefined && <Field.Description className={styles.description}>{description}</Field.Description>}
        </>
    );
    if (scope === 'item') {
        return <Field.Item className={styles.field}>{content}</Field.Item>;
    }
    return (
        <Field.Root disabled={disabled ?? false} className={styles.field}>
            {content}
        </Field.Root>
    );
}
