import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { ChoiceLabel } from '../ChoiceLabel/ChoiceLabel';
import styles from './Checkbox.module.css';

type CheckboxProps = {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    /** Visible label; omit only when `aria-label` names the checkbox. */
    label?: ReactNode | undefined;
    description?: ReactNode | undefined;
    indeterminate?: boolean | undefined;
    disabled?: boolean | undefined;
    size?: 'sm' | 'md' | undefined;
    'aria-label'?: string | undefined;
    className?: string | undefined;
    'data-testid'?: string | undefined;
};

/** `role="checkbox"` with a wrapping label. */
export function Checkbox({
    checked,
    onCheckedChange,
    label,
    description,
    indeterminate,
    disabled,
    size = 'md',
    className,
    'data-testid': testId,
    ...rest
}: CheckboxProps) {
    const control = (
        <BaseCheckbox.Root
            checked={checked}
            onCheckedChange={(next) => onCheckedChange(next)}
            indeterminate={indeterminate ?? false}
            disabled={disabled ?? false}
            data-size={size}
            {...rest}
            {...(label === undefined ? { 'data-testid': testId } : {})}
            className={clsx(styles.box, label === undefined && className)}
        >
            <BaseCheckbox.Indicator className={styles.indicator} keepMounted={false}>
                <svg viewBox="0 0 16 16" aria-hidden="true" className={styles.glyph}>
                    {indeterminate ? <path d="M4 8h8" /> : <path d="M3.5 8.5l3 3 6-7" />}
                </svg>
            </BaseCheckbox.Indicator>
        </BaseCheckbox.Root>
    );
    if (label === undefined) {
        return control;
    }
    return <ChoiceLabel control={control} label={label} description={description} disabled={disabled ?? false} className={className} data-testid={testId} />;
}
