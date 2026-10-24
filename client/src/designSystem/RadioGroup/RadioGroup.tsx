import { Field } from '@base-ui/react/field';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup as BaseRadioGroup } from '@base-ui/react/radio-group';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { ChoiceLabel } from '../ChoiceLabel/ChoiceLabel';
import styles from './RadioGroup.module.css';

export type RadioOption<V extends string> = {
    value: V;
    label: ReactNode;
    description?: ReactNode | undefined;
    disabled?: boolean | undefined;
    'data-testid'?: string | undefined;
};

type RadioGroupProps<V extends string> = {
    value: V;
    onValueChange: (value: V) => void;
    options: readonly RadioOption<V>[];
    /** Names the group (`role="radiogroup"`). */
    'aria-label'?: string | undefined;
    'aria-labelledby'?: string | undefined;
    direction?: 'column' | 'row' | undefined;
    disabled?: boolean | undefined;
    className?: string | undefined;
    'data-testid'?: string | undefined;
};

export function RadioGroup<V extends string>({ value, onValueChange, options, direction = 'column', disabled, className, ...rest }: RadioGroupProps<V>) {
    return (
        // Base UI scopes each option's Field.Item label to a surrounding Field.Root.
        <Field.Root className={styles.field}>
            <BaseRadioGroup<V>
                value={value}
                onValueChange={(next) => onValueChange(next)}
                disabled={disabled ?? false}
                data-direction={direction}
                {...rest}
                className={clsx(styles.group, className)}
            >
                {options.map((option) => (
                    <ChoiceLabel
                        key={option.value}
                        scope="item"
                        disabled={(disabled || option.disabled) ?? false}
                        label={option.label}
                        description={option.description}
                        data-testid={option['data-testid']}
                        control={
                            <Radio.Root value={option.value} disabled={option.disabled ?? false} className={styles.radio}>
                                <Radio.Indicator className={styles.dot} />
                            </Radio.Root>
                        }
                    />
                ))}
            </BaseRadioGroup>
        </Field.Root>
    );
}
