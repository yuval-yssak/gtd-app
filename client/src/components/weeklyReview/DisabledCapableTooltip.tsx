import Tooltip from '@mui/material/Tooltip';

interface DisabledCapableTooltipProps {
    title: string;
    /** Hover/interaction target for tests — a disabled child swallows pointer events, the wrapper doesn't. */
    wrapperTestId?: string;
    children: React.ReactNode;
}

/**
 * Tooltip that keeps working over a disabled button: a disabled MUI button has
 * pointer-events: none and would never open the tooltip, so the child is wrapped in a span that
 * still fires the pointer events MUI listens on.
 */
export function DisabledCapableTooltip({ title, wrapperTestId, children }: DisabledCapableTooltipProps) {
    return (
        <Tooltip title={title}>
            <span data-testid={wrapperTestId}>{children}</span>
        </Tooltip>
    );
}
