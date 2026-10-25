import type { ReactNode } from 'react';
import { Tooltip } from '../designSystem';
import styles from './DisabledCapableTooltip.module.css';

interface DisabledCapableTooltipProps {
    title: string;
    /** Hover/interaction target for tests — a disabled child swallows pointer events, the wrapper doesn't. */
    wrapperTestId?: string | undefined;
    children: ReactNode;
}

/**
 * Tooltip that keeps working over a disabled button: a disabled button fires no pointer events and
 * would never open the tooltip, so the child is wrapped in a span that still fires them. The
 * wrapper is not the control, so the Tooltip leaves the button its own accessible name.
 */
export function DisabledCapableTooltip({ title, wrapperTestId, children }: DisabledCapableTooltipProps) {
    return (
        <Tooltip title={title}>
            <span className={styles.anchor} data-testid={wrapperTestId}>
                {children}
            </span>
        </Tooltip>
    );
}
