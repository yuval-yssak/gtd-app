import { Button as BaseButton } from '@base-ui/react/button';
import { clsx } from 'clsx';
import type { ComponentProps, ReactNode } from 'react';
import { Spinner } from '../Spinner/Spinner';
import styles from './Button.module.css';

export type ButtonVariant = 'solid' | 'outline' | 'ghost';
export type ButtonTone = 'accent' | 'neutral' | 'danger' | 'warning' | 'success';
export type ButtonSize = 'sm' | 'md' | 'lg';

/** The look shared by `Button` and `ButtonLink`. */
export type ButtonAppearance = {
    /** solid = MUI contained, outline = outlined, ghost = text (MUI's default). */
    variant?: ButtonVariant | undefined;
    tone?: ButtonTone | undefined;
    size?: ButtonSize | undefined;
    startIcon?: ReactNode | undefined;
    endIcon?: ReactNode | undefined;
    fullWidth?: boolean | undefined;
};

export type ButtonProps = Omit<ComponentProps<'button'>, 'className'> &
    ButtonAppearance & {
        className?: string | undefined;
        /** Shows a spinner in place of the start icon and disables the button. */
        loading?: boolean | undefined;
    };

/** A native `<button>`. For navigation that should look like a button, use `ButtonLink`. */
export function Button({
    variant = 'ghost',
    tone = 'accent',
    size = 'md',
    startIcon,
    endIcon,
    loading,
    fullWidth,
    disabled,
    className,
    children,
    ...rest
}: ButtonProps) {
    return (
        <BaseButton
            {...appearanceAttributes({ variant, tone, size, fullWidth })}
            data-loading={loading || undefined}
            aria-busy={loading || undefined}
            disabled={disabled || loading}
            {...rest}
            className={clsx(styles.button, className)}
        >
            <ButtonContent startIcon={loading ? <Spinner size={16} tone="inherit" aria-hidden="true" /> : startIcon} endIcon={endIcon}>
                {children}
            </ButtonContent>
        </BaseButton>
    );
}

/** The data attributes the stylesheet keys on. */
export function appearanceAttributes({ variant = 'ghost', tone = 'accent', size = 'md', fullWidth }: ButtonAppearance) {
    return { 'data-variant': variant, 'data-tone': tone, 'data-size': size, 'data-full-width': fullWidth || undefined };
}

export function ButtonContent({ startIcon, endIcon, children }: Pick<ButtonAppearance, 'startIcon' | 'endIcon'> & { children?: ReactNode }) {
    return (
        <>
            <IconSlot>{startIcon}</IconSlot>
            {children}
            <IconSlot>{endIcon}</IconSlot>
        </>
    );
}

function IconSlot({ children }: { children: ReactNode }) {
    if (children === undefined || children === null || children === false) return null;
    return (
        <span className={styles.iconSlot} aria-hidden="true">
            {children}
        </span>
    );
}
