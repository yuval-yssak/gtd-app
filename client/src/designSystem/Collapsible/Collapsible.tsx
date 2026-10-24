import { Collapsible as BaseCollapsible } from '@base-ui/react/collapsible';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import styles from './Collapsible.module.css';

type CollapsibleProps = {
    /** Whether the content is shown (MUI Collapse `in`). */
    open: boolean;
    children: ReactNode;
    /** Keep the content mounted while collapsed (MUI's default); off unmounts it. */
    keepMounted?: boolean | undefined;
    className?: string | undefined;
    'data-testid'?: string | undefined;
};

/**
 * Animated show/hide of a region driven by external state (MUI Collapse). The toggle lives with
 * the caller, so this renders only the panel.
 */
export function Collapsible({ open, children, keepMounted = true, className, ...rest }: CollapsibleProps) {
    return (
        <BaseCollapsible.Root open={open}>
            <BaseCollapsible.Panel keepMounted={keepMounted} {...rest} className={clsx(styles.panel, className)}>
                {children}
            </BaseCollapsible.Panel>
        </BaseCollapsible.Root>
    );
}
