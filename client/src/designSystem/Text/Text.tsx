import { clsx } from 'clsx';
import type { HTMLAttributes } from 'react';
import styles from './Text.module.css';

/**
 * The type ramp. Each variant keeps the size and line height of the MUI variant it replaces
 * (in parentheses) so text blocks keep their height:
 * display (h3) · headline (h4) · title (h5) · titleSm (h6) · subtitle (subtitle1) ·
 * subtitleSm (subtitle2) · body (body1) · bodySm (body2) · caption · overline.
 */
export type TextVariant = 'display' | 'headline' | 'title' | 'titleSm' | 'subtitle' | 'subtitleSm' | 'body' | 'bodySm' | 'caption' | 'overline';

export type TextTone = 'primary' | 'secondary' | 'disabled' | 'accent' | 'error' | 'warning' | 'success' | 'info' | 'inherit';

export type TextElement = 'p' | 'span' | 'div' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'label' | 'li' | 'strong' | 'em' | 'small' | 'legend' | 'dt' | 'dd';

// The element each variant renders by default — MUI's mapping, so the page outline (and every
// e2e `getByRole('heading')`) is unchanged by the migration. `as` overrides it.
const DEFAULT_ELEMENT: Record<TextVariant, TextElement> = {
    display: 'h3',
    headline: 'h4',
    title: 'h5',
    titleSm: 'h6',
    subtitle: 'h6',
    subtitleSm: 'h6',
    body: 'p',
    bodySm: 'p',
    caption: 'span',
    overline: 'span',
};

type TextProps = HTMLAttributes<HTMLElement> & {
    as?: TextElement | undefined;
    variant?: TextVariant | undefined;
    tone?: TextTone | undefined;
    weight?: 'regular' | 'medium' | 'semibold' | 'bold' | undefined;
    /** One line, ellipsis on overflow. */
    truncate?: boolean | undefined;
    /** Only meaningful with `as="label"`. */
    htmlFor?: string | undefined;
    'data-testid'?: string | undefined;
};

export function Text({ as, variant = 'body', tone = 'primary', weight, truncate, className, ...rest }: TextProps) {
    const Element = as ?? DEFAULT_ELEMENT[variant];
    return (
        <Element
            data-variant={variant}
            data-tone={tone}
            data-weight={weight}
            data-truncate={truncate || undefined}
            {...rest}
            className={clsx(styles.text, className)}
        />
    );
}
