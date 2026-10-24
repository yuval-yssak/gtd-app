import { clsx } from 'clsx';
import type { ComponentProps, MouseEvent, ReactNode } from 'react';
import styles from './Chip.module.css';

export type ChipTone = 'neutral' | 'accent' | 'success' | 'warning' | 'error' | 'info';

type SharedChipProps = {
    label: ReactNode;
    /** soft = MUI filled (tinted fill), outline = MUI outlined. */
    variant?: 'soft' | 'outline' | undefined;
    tone?: ChipTone | undefined;
    size?: 'sm' | 'md' | undefined;
    icon?: ReactNode | undefined;
    className?: string | undefined;
    'data-testid'?: string | undefined;
};

type StaticChipProps = SharedChipProps &
    Omit<ComponentProps<'span'>, 'onClick' | 'children' | 'className'> & {
        onClick?: undefined;
        /** Adds a remove button named "Remove {label}" (or `deleteLabel`). */
        onDelete?: (() => void) | undefined;
        deleteLabel?: string | undefined;
    };

type ClickableChipProps = SharedChipProps &
    Omit<ComponentProps<'button'>, 'onClick' | 'children' | 'className' | 'type'> & {
        /** Makes the chip itself a `<button>`. */
        onClick: (event: MouseEvent<HTMLButtonElement>) => void;
        /**
         * A toggle chip's state: filled accent plus `aria-pressed`, mirrored as `data-selected` so
         * tests read the state without depending on styling.
         */
        selected?: boolean | undefined;
    };

export type ChipProps = StaticChipProps | ClickableChipProps;

export function Chip(props: ChipProps) {
    if (props.onClick) return <ClickableChip {...props} />;
    return <StaticChip {...props} />;
}

function ChipContent({ icon, label }: Pick<SharedChipProps, 'icon' | 'label'>) {
    return (
        <>
            {icon !== undefined && (
                <span className={styles.icon} aria-hidden="true">
                    {icon}
                </span>
            )}
            <span className={styles.label}>{label}</span>
        </>
    );
}

function ClickableChip({ label, variant = 'soft', tone = 'neutral', size = 'sm', icon, selected, className, ...rest }: ClickableChipProps) {
    return (
        <button
            type="button"
            data-variant={variant}
            data-tone={tone}
            data-size={size}
            data-selected={selected || undefined}
            data-clickable=""
            aria-pressed={selected}
            {...rest}
            className={clsx(styles.chip, className)}
        >
            <ChipContent icon={icon} label={label} />
        </button>
    );
}

function StaticChip({
    label,
    variant = 'soft',
    tone = 'neutral',
    size = 'sm',
    icon,
    onDelete,
    deleteLabel,
    onClick: _onClick,
    className,
    ...rest
}: StaticChipProps) {
    return (
        <span data-variant={variant} data-tone={tone} data-size={size} {...rest} className={clsx(styles.chip, className)}>
            <ChipContent icon={icon} label={label} />
            {onDelete && (
                <button type="button" className={styles.delete} aria-label={deleteLabel ?? removeLabelFor(label)} onClick={onDelete}>
                    <svg viewBox="0 0 16 16" aria-hidden="true" className={styles.deleteGlyph}>
                        <path d="M4.5 4.5l7 7m0-7l-7 7" />
                    </svg>
                </button>
            )}
        </span>
    );
}

function removeLabelFor(label: ReactNode) {
    return typeof label === 'string' ? `Remove ${label}` : 'Remove';
}
