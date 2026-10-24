import { Copy } from 'lucide-react';
import { type MouseEvent, useState } from 'react';
import { IconButton, type IconButtonProps, Toast, Tooltip } from '../designSystem';
import { withShortcutHint } from '../lib/rowShortcuts';

export interface CopyButtonProps {
    value: string;
    /** What is being copied, in words ("item ID", "connector URL") — drives the tooltip and aria-label. */
    label: string;
    testId: string;
    /** Toast text on success; defaults to "Copied <label>". */
    copiedMessage?: string | undefined;
    /** Extra props for the icon button — a list row takes it out of the tab order and names it for the letter shortcut. */
    buttonProps?: (Partial<Omit<IconButtonProps, 'aria-label'>> & Record<`data-${string}`, string>) | undefined;
    /** The letter that presses this button on a focused list row — shown in the tooltip ("Copy item ID (c)"). */
    shortcutKey?: string | undefined;
}

type Feedback = 'idle' | 'copied' | 'failed';

/**
 * Small copy-to-clipboard icon. Success/failure shows in both the tooltip (instant, desktop) and a
 * transient toast — the tooltip alone never appears on a phone tap. Clipboard writes can fail
 * (Safari Private, iframes without permission, unfocused document); silent degradation is
 * unacceptable, so the failure toast tells the user to select the text manually.
 */
export function CopyButton({ value, label, testId, copiedMessage = `Copied ${label}`, buttonProps, shortcutKey }: CopyButtonProps) {
    const [feedback, setFeedback] = useState<Feedback>('idle');

    async function onCopy() {
        try {
            await navigator.clipboard.writeText(value);
            setFeedback('copied');
        } catch {
            setFeedback('failed');
        }
    }

    function onClick(e: MouseEvent) {
        // Defensive: keeps the button safe inside a clickable row, where a click must not also open the row.
        e.stopPropagation();
        void onCopy();
    }

    const idleTitle = shortcutKey ? withShortcutHint(`Copy ${label}`, shortcutKey) : `Copy ${label}`;
    const tooltipTitle = feedback === 'copied' ? 'Copied!' : feedback === 'failed' ? 'Copy failed' : idleTitle;
    const message = feedback === 'copied' ? copiedMessage : 'Could not copy. Select text manually.';

    return (
        <>
            <Tooltip title={tooltipTitle}>
                <IconButton size="sm" {...buttonProps} onClick={onClick} aria-label={`Copy ${label}`} data-testid={testId}>
                    <Copy />
                </IconButton>
            </Tooltip>
            <Toast
                open={feedback !== 'idle'}
                tone={feedback === 'failed' ? 'error' : 'neutral'}
                autoHideDuration={2000}
                onClose={() => setFeedback('idle')}
                message={message}
                data-testid={`${testId}Feedback`}
            />
        </>
    );
}
