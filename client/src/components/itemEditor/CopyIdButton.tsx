import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import IconButton from '@mui/material/IconButton';
import Snackbar from '@mui/material/Snackbar';
import Tooltip from '@mui/material/Tooltip';
import { useState } from 'react';

interface Props {
    id: string;
}

type Feedback = 'idle' | 'copied' | 'failed';

/**
 * Renders a small copy-to-clipboard icon for the item ID. Surfaces success/failure via tooltip
 * swap (instant) plus a transient Snackbar (so the action feels acknowledged but isn't modal).
 * Clipboard writes can fail under some browser/security configurations (e.g. Safari Private,
 * iframes with no clipboard permission) — silent degradation is unacceptable since the user
 * explicitly asked for the ID; the failure snackbar tells them to select text manually.
 */
export function CopyIdButton({ id }: Props) {
    const [feedback, setFeedback] = useState<Feedback>('idle');

    async function onCopy() {
        try {
            await navigator.clipboard.writeText(id);
            setFeedback('copied');
        } catch {
            setFeedback('failed');
        }
    }

    const tooltipTitle = feedback === 'copied' ? 'Copied!' : feedback === 'failed' ? 'Copy failed' : 'Copy item ID';
    const message = feedback === 'copied' ? `Copied: ${id}` : 'Could not copy. Select text manually.';

    return (
        <>
            <Tooltip title={tooltipTitle}>
                <IconButton size="small" onClick={() => void onCopy()} aria-label="Copy item ID" data-testid="copyItemIdButton">
                    <ContentCopyIcon fontSize="small" />
                </IconButton>
            </Tooltip>
            <Snackbar open={feedback !== 'idle'} autoHideDuration={2000} onClose={() => setFeedback('idle')} message={message} />
        </>
    );
}
