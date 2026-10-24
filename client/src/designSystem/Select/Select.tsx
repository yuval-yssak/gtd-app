import { Select as BaseSelect } from '@base-ui/react/select';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { MODAL_POPUP_ATTR } from '../../lib/keyboardRegionDom';
import styles from './Select.module.css';

export type SelectOption<V extends string> = {
    value: V;
    label: ReactNode;
    disabled?: boolean | undefined;
};

type SelectProps<V extends string> = {
    value: V;
    onValueChange: (value: V) => void;
    options: readonly SelectOption<V>[];
    /** Visible label above the trigger; it names the `combobox`. Omit only with `aria-label`. */
    label?: ReactNode | undefined;
    'aria-label'?: string | undefined;
    size?: 'sm' | 'md' | undefined;
    fullWidth?: boolean | undefined;
    disabled?: boolean | undefined;
    className?: string | undefined;
    'data-testid'?: string | undefined;
};

/**
 * Single-value picker (MUI Select / TextField select). The trigger is `role="combobox"`, options are
 * `role="option"` — the roles MUI rendered, so e2e queries carry over.
 */
export function Select<V extends string>({
    value,
    onValueChange,
    options,
    label,
    size = 'sm',
    fullWidth,
    disabled,
    className,
    'aria-label': ariaLabel,
    'data-testid': testId,
}: SelectProps<V>) {
    return (
        <BaseSelect.Root<V>
            value={value}
            // Null is "cleared"; this select never offers a clear, so it is ignored.
            onValueChange={(next) => next !== null && onValueChange(next)}
            items={options}
            disabled={disabled ?? false}
        >
            <div className={clsx(styles.root, className)} data-full-width={fullWidth || undefined} data-size={size}>
                {label !== undefined && <BaseSelect.Label className={styles.label}>{label}</BaseSelect.Label>}
                <BaseSelect.Trigger className={styles.trigger} aria-label={ariaLabel} data-testid={testId}>
                    <BaseSelect.Value className={styles.value} />
                    <BaseSelect.Icon className={styles.icon}>
                        <svg viewBox="0 0 16 16" aria-hidden="true" className={styles.chevron}>
                            <path d="M4 6l4 4 4-4" />
                        </svg>
                    </BaseSelect.Icon>
                </BaseSelect.Trigger>
            </div>
            <BaseSelect.Portal>
                <BaseSelect.Positioner className={styles.positioner} sideOffset={4} alignItemWithTrigger={false}>
                    <BaseSelect.Popup {...{ [MODAL_POPUP_ATTR]: '' }} className={styles.popup}>
                        <BaseSelect.List>
                            {options.map((option) => (
                                <BaseSelect.Item key={option.value} value={option.value} disabled={option.disabled ?? false} className={styles.item}>
                                    <BaseSelect.ItemText className={styles.itemText}>{option.label}</BaseSelect.ItemText>
                                    <BaseSelect.ItemIndicator className={styles.itemIndicator}>
                                        <svg viewBox="0 0 16 16" aria-hidden="true" className={styles.check}>
                                            <path d="M3.5 8.5l3 3 6-7" />
                                        </svg>
                                    </BaseSelect.ItemIndicator>
                                </BaseSelect.Item>
                            ))}
                        </BaseSelect.List>
                    </BaseSelect.Popup>
                </BaseSelect.Positioner>
            </BaseSelect.Portal>
        </BaseSelect.Root>
    );
}
