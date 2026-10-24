import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { ChoiceLabel } from '../ChoiceLabel/ChoiceLabel';
import styles from './Switch.module.css';

type SwitchProps = {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    /** Visible label; omit only when `aria-label` names the switch. */
    label?: ReactNode | undefined;
    description?: ReactNode | undefined;
    disabled?: boolean | undefined;
    /** Put the switch after the text (settings rows). */
    placement?: 'start' | 'end' | undefined;
    'aria-label'?: string | undefined;
    /** Lands on the focusable switch itself — e.g. a keyboard region's `tabIndex: -1` and item marker. */
    controlProps?: ({ tabIndex?: number | undefined } & Record<`data-${string}`, string>) | undefined;
    className?: string | undefined;
    'data-testid'?: string | undefined;
};

/** On/off toggle with `role="switch"`. */
export function Switch({
    checked,
    onCheckedChange,
    label,
    description,
    disabled,
    placement,
    controlProps,
    className,
    'data-testid': testId,
    ...rest
}: SwitchProps) {
    const control = (
        <BaseSwitch.Root
            checked={checked}
            onCheckedChange={(next) => onCheckedChange(next)}
            disabled={disabled ?? false}
            {...rest}
            {...controlProps}
            {...(label === undefined ? { 'data-testid': testId } : {})}
            className={clsx(styles.track, label === undefined && className)}
        >
            <BaseSwitch.Thumb className={styles.thumb} />
        </BaseSwitch.Root>
    );
    if (label === undefined) return control;
    return (
        <ChoiceLabel
            control={control}
            label={label}
            description={description}
            disabled={disabled ?? false}
            placement={placement ?? 'start'}
            className={className}
            data-testid={testId}
        />
    );
}
