import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import IconButton, { type IconButtonProps } from '@mui/material/IconButton';
import Snackbar from '@mui/material/Snackbar';
import Tooltip from '@mui/material/Tooltip';
import { useState } from 'react';
import { withShortcutHint } from '../lib/rowShortcuts';

export interface CopyButtonProps {
    value: string;
    /** What is being copied, in words ("item ID", "connector URL") — drives the tooltip and aria-label. */
    label: string;
    testId: string;
    /** Snackbar text on success; defaults to "Copied <label>". */
    copiedMessage?: string;
    /** Extra props for the icon button — a list row takes it out of the tab order and names it for the letter shortcut. */
    buttonProps?: Partial<IconButtonProps> & Record<`data-${string}`, string>;
    /** The letter that presses this button on a focused list row — shown in the tooltip ("Copy item ID (c)"). */
    shortcutKey?: string;
}

type Feedback = 'idle' | 'copied' | 'failed';

/**
 * Small copy-to-clipboard icon. Success/failure shows in both the tooltip (instant, desktop) and a
 * transient Snackbar — the tooltip alone never appears on a phone tap. Clipboard writes can fail
 * (Safari Private, iframes without permission, unfocused document); silent degradation is
 * unacceptable, so the failure Snackbar tells the user to select the text manually.
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

    // Defensive stopPropagation: keeps the button safe inside a clickable row (list rows render it
    // as a secondaryAction today, so this is a no-op at current call sites).
    function onClick(e: React.MouseEvent) {
        e.stopPropagation();
        void onCopy();
    }

    const idleTitle = shortcutKey ? withShortcutHint(`Copy ${label}`, shortcutKey) : `Copy ${label}`;
    const tooltipTitle = feedback === 'copied' ? 'Copied!' : feedback === 'failed' ? 'Copy failed' : idleTitle;
    const message = feedback === 'copied' ? copiedMessage : 'Could not copy. Select text manually.';

    return (
        <>
            <Tooltip title={tooltipTitle}>
                <IconButton size="small" {...buttonProps} onClick={onClick} aria-label={`Copy ${label}`} data-testid={testId}>
                    <ContentCopyIcon fontSize="small" />
                </IconButton>
            </Tooltip>
            <Snackbar
                open={feedback !== 'idle'}
                autoHideDuration={2000}
                onClose={() => setFeedback('idle')}
                message={message}
                data-testid={`${testId}Feedback`}
            />
        </>
    );
}
