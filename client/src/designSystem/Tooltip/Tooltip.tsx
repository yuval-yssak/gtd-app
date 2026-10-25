import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import { type ReactElement, type ReactNode, useState } from 'react';
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
};

/**
 * Hover/focus hint. Mirrors MUI's contract so the migration changes no accessible names: a string
 * `title` becomes the trigger's `aria-label` unless the trigger already has one. Tooltips never
 * open on touch — information a phone user needs must not live only here.
 */
export function Tooltip({ title, children, placement = 'bottom' }: TooltipProps) {
    if (title === '' || title === null || title === undefined) {
        return children;
    }
    // A separate component so its open state unmounts with the title: an emptied title that comes
    // back must not find the tooltip still latched open from a hover that has since ended.
    return (
        <TitledTooltip title={title} placement={placement}>
            {children}
        </TitledTooltip>
    );
}

function TitledTooltip({ title, children, placement }: Required<TooltipProps>) {
    const [isOpen, setIsOpen] = useState(false);
    return (
        <BaseTooltip.Root
            open={isOpen}
            onOpenChange={(next, details) => {
                letEscapeReachPage(next, details);
                setIsOpen(next);
            }}
        >
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

/**
 * Escape closes the tooltip AND reaches the page untouched (MUI parity): a tooltip is a hint, not a
 * layer, so it must not swallow the page's Escape-to-leave when it shows on focus. Base UI's own
 * close would preventDefault and stopPropagation the key; cancelling it skips both, and the
 * controlled `open` closes the tooltip instead. (The cancel also skips Base UI's close bookkeeping —
 * its focus re-open block and instant close — so the tooltip fades out; harmless, blur resets it.)
 */
function letEscapeReachPage(isOpening: boolean, details: BaseTooltip.Root.ChangeEventDetails) {
    if (!isOpening && details.reason === 'escape-key') {
        details.cancel();
        details.allowPropagation();
    }
}

// A wrapper element (the <span> around a disabled button) is not the control; naming it would put
// aria-label on a generic element, which ARIA prohibits.
const WRAPPER_ELEMENTS: ReadonlySet<unknown> = new Set(['span', 'div']);

function accessibleNameFor(title: ReactNode, trigger: TriggerElement) {
    const hasOwnName = trigger.props['aria-label'] !== undefined || trigger.props['aria-labelledby'] !== undefined;
    const isWrapper = WRAPPER_ELEMENTS.has(trigger.type);
    return typeof title === 'string' && !hasOwnName && !isWrapper ? { 'aria-label': title } : {};
}
