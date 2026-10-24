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

/**
 * Exclusive by default: exactly one option is always pressed (MUI `exclusive` with the null guard
 * every site had). `allowDeselect` lets the active segment be pressed off, leaving the value empty.
 */
type ToggleSelection<V extends string> =
    | { allowDeselect?: false | undefined; value: V; onValueChange: (value: V) => void }
    | { allowDeselect: true; value: V | ''; onValueChange: (value: V | '') => void };

type ToggleGroupProps<V extends string> = ToggleSelection<V> & {
    options: readonly ToggleOption<V>[];
    size?: 'sm' | 'md' | undefined;
    disabled?: boolean | undefined;
    'aria-label'?: string | undefined;
    className?: string | undefined;
    'data-testid'?: string | undefined;
};

/** Segmented control (MUI ToggleButtonGroup exclusive). Each segment is a pressed/unpressed button. */
export function ToggleGroup<V extends string>({ options, size = 'sm', disabled, className, ...props }: ToggleGroupProps<V>) {
    const { allowDeselect: _allowDeselect, value, onValueChange, ...rest } = props;
    return (
        <BaseToggleGroup<V>
            value={value === '' ? [] : [value]}
            onValueChange={(next) => {
                const [picked] = next;
                if (picked !== undefined) {
                    onValueChange(picked);
                    return;
                }
                // Pressing the active segment empties the group: clear when allowed, else keep the choice.
                // Checking `props.allowDeselect` narrows `props` to the deselectable shape, whose callback accepts `''`.
                if (props.allowDeselect) {
                    props.onValueChange('');
                }
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
