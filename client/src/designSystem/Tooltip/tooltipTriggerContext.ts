import { createContext, useContext } from 'react';

// True inside a design-system Tooltip's trigger, so IconButton skips its native `title` fallback —
// otherwise the browser tooltip would appear on top of ours.
const TooltipTriggerContext = createContext(false);

export const TooltipTriggerProvider = TooltipTriggerContext.Provider;

export function useIsInsideTooltip() {
    return useContext(TooltipTriggerContext);
}
