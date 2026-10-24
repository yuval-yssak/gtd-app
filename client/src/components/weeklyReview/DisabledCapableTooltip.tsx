import { Tooltip } from '../../designSystem';

interface DisabledCapableTooltipProps {
    title: string;
    /** Hover/interaction target for tests — a disabled child swallows pointer events, the wrapper doesn't. */
    wrapperTestId?: string;
    children: React.ReactNode;
}

/**
 * Tooltip that keeps working over a disabled button: a disabled button fires no pointer events and
 * would never open the tooltip, so the child is wrapped in a span that still fires them.
 */
export function DisabledCapableTooltip({ title, wrapperTestId, children }: DisabledCapableTooltipProps) {
    return (
        <Tooltip title={title}>
            <span data-testid={wrapperTestId}>{children}</span>
        </Tooltip>
    );
}
