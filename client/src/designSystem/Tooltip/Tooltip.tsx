import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import type { ReactElement, ReactNode } from 'react';
import styles from './Tooltip.module.css';
import { TooltipTriggerProvider } from './tooltipTriggerContext';

// MUI's enterDelay; the shortcut-hint e2e specs hover and expect the tooltip promptly.
const OPEN_DELAY_MS = 100;

type TriggerElement = ReactElement<{ 'aria-label'?: string; 'aria-labelledby'?: string }>;

type TooltipProps = {
    /** Text shown on hover/focus. A string also names a trigger that has no aria-label of its own. */
    title: ReactNode;
    /**
     * The trigger. It must spread props and forward `ref` onto one DOM element (every DS component
     * does). A disabled button gets no pointer events — wrap it in a `<span>` to keep the tooltip.
     */
    children: TriggerElement;
    placement?: 'top' | 'bottom' | 'left' | 'right' | undefined;
    disabled?: boolean | undefined;
};

/**
 * Hover/focus hint. Mirrors MUI's contract so the migration changes no accessible names: a string
 * `title` becomes the trigger's `aria-label` unless the trigger already has one. Tooltips never
 * open on touch — information a phone user needs must not live only here.
 */
export function Tooltip({ title, children, placement = 'bottom', disabled }: TooltipProps) {
    if (title === '' || title === null || title === undefined) return children;
    return (
        <BaseTooltip.Root disabled={disabled ?? false}>
            <TooltipTriggerProvider value={true}>
                <BaseTooltip.Trigger delay={OPEN_DELAY_MS} closeDelay={0} render={children} {...accessibleNameFor(title, children)} />
            </TooltipTriggerProvider>
            <BaseTooltip.Portal>
                <BaseTooltip.Positioner side={placement} sideOffset={6} collisionPadding={8} className={styles.positioner}>
                    <BaseTooltip.Popup role="tooltip" className={styles.popup}>
                        {title}
                    </BaseTooltip.Popup>
                </BaseTooltip.Positioner>
            </BaseTooltip.Portal>
        </BaseTooltip.Root>
    );
}

// A wrapper element (the <span> around a disabled button) is not the control; naming it would put
// aria-label on a generic element, which ARIA prohibits.
const WRAPPER_ELEMENTS: ReadonlySet<unknown> = new Set(['span', 'div']);

function accessibleNameFor(title: ReactNode, trigger: TriggerElement) {
    const hasOwnName = trigger.props['aria-label'] !== undefined || trigger.props['aria-labelledby'] !== undefined;
    const isWrapper = WRAPPER_ELEMENTS.has(trigger.type);
    return typeof title === 'string' && !hasOwnName && !isWrapper ? { 'aria-label': title } : {};
}
