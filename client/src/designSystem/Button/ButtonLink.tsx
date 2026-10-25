import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { clsx } from 'clsx';
import type { ComponentProps, ReactElement } from 'react';
import { appearanceAttributes, type ButtonAppearance, ButtonContent } from './Button';
import styles from './Button.module.css';

type ButtonLinkProps = Omit<ComponentProps<'a'>, 'className'> &
    ButtonAppearance & {
        className?: string | undefined;
        /** The link element to render — a router `<Link to=… />`; defaults to a plain `<a>`. */
        render?: ReactElement | undefined;
    };

/**
 * A link that looks like a `Button`. It stays a link (`role="link"`, Enter only, middle-click and
 * "open in new tab" work) — Base UI's Button with `nativeButton={false}` would stamp `role="button"`
 * on the anchor instead.
 */
export function ButtonLink({ render, variant, tone, size, startIcon, fullWidth, className, children, ...rest }: ButtonLinkProps) {
    return useRender({
        defaultTagName: 'a',
        render,
        props: mergeProps<'a'>(
            {
                ...appearanceAttributes({ variant, tone, size, fullWidth }),
                className: clsx(styles.button, className),
                children: <ButtonContent startIcon={startIcon}>{children}</ButtonContent>,
            },
            rest,
        ),
    });
}
