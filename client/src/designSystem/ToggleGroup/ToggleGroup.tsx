import { Toggle } from '@base-ui/react/toggle';
import { ToggleGroup as BaseToggleGroup } from '@base-ui/react/toggle-group';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import styles from './ToggleGroup.module.css';

export type ToggleOption<V extends string> = {
    value: V;
    label: ReactNode;
    'aria-label'?: string | undefined;
    'data-testid'?: string | undefined;
};

type ToggleGroupProps<V extends string> = {
    value: V;
    /** Exclusive: exactly one option is always pressed (MUI `exclusive` with the null guard every site had). */
    onValueChange: (value: V) => void;
    options: readonly ToggleOption<V>[];
    size?: 'sm' | 'md' | undefined;
    disabled?: boolean | undefined;
    'aria-label'?: string | undefined;
    className?: string | undefined;
    'data-testid'?: string | undefined;
};

/** Segmented control (MUI ToggleButtonGroup exclusive). Each segment is a pressed/unpressed button. */
export function ToggleGroup<V extends string>({ value, onValueChange, options, size = 'sm', disabled, className, ...rest }: ToggleGroupProps<V>) {
    return (
        <BaseToggleGroup<V>
            value={[value]}
            onValueChange={(next) => {
                // Pressing the active segment would empty the group; keep the current choice instead.
                const [picked] = next;
                if (picked !== undefined) onValueChange(picked);
            }}
            disabled={disabled ?? false}
            data-size={size}
            {...rest}
            className={clsx(styles.group, className)}
        >
            {options.map((option) => (
                <Toggle key={option.value} value={option.value} aria-label={option['aria-label']} data-testid={option['data-testid']} className={styles.toggle}>
                    {option.label}
                </Toggle>
            ))}
        </BaseToggleGroup>
    );
}
