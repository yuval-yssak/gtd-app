import { Button as BaseButton } from '@base-ui/react/button';
import { clsx } from 'clsx';
import type { ComponentProps } from 'react';
import { useIsInsideTooltip } from '../Tooltip/tooltipTriggerContext';
import styles from './IconButton.module.css';

/**
 * An icon has no text, so the button needs a name: `aria-label` normally, or `title` alone where an
 * `aria-label` would collide with a field label (a "Clear Expected by" button inside the "Expected by"
 * field would make every `getByLabel('Expected by')` match it too).
 */
type IconButtonNaming = { 'aria-label': string; title?: string | undefined } | { 'aria-label'?: never; title: string };

export type IconButtonProps = Omit<ComponentProps<'button'>, 'className' | 'aria-label' | 'title'> &
    IconButtonNaming & {
        className?: string | undefined;
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
    const ariaLabel = rest['aria-label'];
    if (import.meta.env.DEV && (ariaLabel ?? title ?? '').trim() === '') {
        console.error('IconButton needs a non-empty aria-label (or title) — it is the only accessible name an icon button has.');
    }
    return (
        <BaseButton
            data-size={size}
            data-tone={tone}
            data-edge={edge}
            data-selected={selected || undefined}
            // Touch devices never show a design-system tooltip, so the native title is the fallback hint.
            // A title-only name is the button's accessible name, so it always stays.
            title={ariaLabel === undefined ? title : isInsideTooltip ? undefined : (title ?? ariaLabel)}
            {...rest}
            className={clsx(styles.iconButton, className)}
        />
    );
}
