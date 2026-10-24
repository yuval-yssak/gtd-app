import { Button as BaseButton } from '@base-ui/react/button';
import { clsx } from 'clsx';
import type { ComponentProps } from 'react';
import { useIsInsideTooltip } from '../Tooltip/tooltipTriggerContext';
import styles from './IconButton.module.css';

export type IconButtonProps = Omit<ComponentProps<'button'>, 'className' | 'aria-label'> & {
    className?: string | undefined;
    /** Required: an icon has no text, so this is the button's only accessible name. */
    'aria-label': string;
    size?: 'sm' | 'md' | undefined;
    tone?: 'neutral' | 'accent' | 'danger' | 'warning' | 'success' | 'inherit' | undefined;
    /** Pull the button into the container's padding so the glyph, not the hit area, aligns. */
    edge?: 'start' | 'end' | undefined;
    /** Pressed/active look for toggle-style icon buttons. */
    selected?: boolean | undefined;
};

/**
 * A square icon-only button. Unknown props (`data-row-action`, `aria-keyshortcuts`, `tabIndex`)
 * pass straight through to the `<button>` — the keyboard regions depend on that.
 */
export function IconButton({ size = 'md', tone = 'neutral', edge, selected, title, className, ...rest }: IconButtonProps) {
    const isInsideTooltip = useIsInsideTooltip();
    if (import.meta.env.DEV && rest['aria-label'].trim() === '') {
        console.error('IconButton needs a non-empty aria-label — it is the only accessible name an icon button has.');
    }
    return (
        <BaseButton
            data-size={size}
            data-tone={tone}
            data-edge={edge}
            data-selected={selected || undefined}
            // Touch devices never show a design-system tooltip, so the native title is the fallback hint.
            title={isInsideTooltip ? undefined : (title ?? rest['aria-label'])}
            {...rest}
            className={clsx(styles.iconButton, className)}
        />
    );
}
