import CloseIcon from '@mui/icons-material/Close';
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined';
import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { dismissSyncIssue, fetchSyncIssues, retrySyncIssue, type SyncIssue, type SyncIssueFailureReason } from '../api/syncApi';
import { SYNC_ISSUES_REFRESH_EVENT } from '../contexts/syncIssuesEvents';
import { useOnline } from '../hooks/useOnline';
import styles from './SyncIssuesPanel.module.css';

/** Polling fallback (ms) — covers the case where no sync activity has fired in a while. */
const POLL_INTERVAL_MS = 30_000;

/**
 * Maps a `failureReason` to a single user-friendly line. The label captures both the action that
 * failed and the *why* — terminal reasons read as a finality ("Event was cancelled…"), retryable
 * ones leave the door open ("could not reach Google Calendar…"). Source-of-truth note: this map
 * mirrors the server's `OpFailureReason` enum; adding a new reason there requires a label here too.
 */
const FAILURE_LABELS: Record<SyncIssueFailureReason, string> = {
    transient_exhausted: "Couldn't reach Google Calendar — please retry.",
    scope_missing: 'Google needs additional permissions to complete this change.',
    calendar_missing: "The target calendar isn't available anymore — pick another or retry.",
    edit_conflict: 'The event changed in Google Calendar — retry to reapply the change.',
    terminal: 'Event was cancelled by the organizer or removed in Google Calendar.',
};

/** Prefix for the issue title — keeps the panel scannable when several entries share a label. */
function titleForOp(op: SyncIssue): string {
    if (op.opType === 'rsvp') {
        return 'RSVP failed';
    }
    if (op.opType === 'update') {
        return 'Update failed';
    }
    return `${op.opType} failed`;
}

/**
 * Sync Issues panel — a single dialog surfacing every persisted op with `syncFailed: true`. The
 * badge in the app shell shows the live count; clicking it opens the dialog. Mount this component
 * unconditionally inside `_authenticated.tsx` — the badge collapses to a no-op when count === 0.
 */
export function SyncIssuesPanel() {
    const [issues, setIssues] = useState<SyncIssue[]>([]);
    const [isOpen, setIsOpen] = useState(false);
    const isOnline = useOnline();

    const refetch = useCallback(async () => {
        try {
            const next = await fetchSyncIssues();
            setIssues(next);
        } catch (err) {
            // Offline / network blip — leave the previous list in place. The next online tick refetches.
            console.warn('[sync-issues] fetch failed; keeping prior list', err);
        }
    }, []);

    // Mount + online + custom-event + polling refetches. The custom event is dispatched by the
    // sync layer when a flush or SSE pull completes, so the panel surfaces a new failure within
    // ~1 SSE round-trip rather than waiting for the polling interval.
    useEffect(() => {
        if (!isOnline) {
            return;
        }
        void refetch();
        const onRefresh = () => void refetch();
        window.addEventListener(SYNC_ISSUES_REFRESH_EVENT, onRefresh);
        // Belt-and-braces polling — covers paths where no sync activity dispatches the event
        // (long-idle tabs in particular).
        const intervalId = window.setInterval(() => void refetch(), POLL_INTERVAL_MS);
        return () => {
            window.removeEventListener(SYNC_ISSUES_REFRESH_EVENT, onRefresh);
            window.clearInterval(intervalId);
        };
    }, [refetch, isOnline]);

    if (issues.length === 0 && !isOpen) {
        return null;
    }

    return (
        <>
            <Tooltip title={`${issues.length} sync issue${issues.length === 1 ? '' : 's'}`}>
                <IconButton size="small" onClick={() => setIsOpen(true)} className={styles.badgeButton} data-testid="syncIssuesBadge">
                    <Badge badgeContent={issues.length} color="error" max={99}>
                        <ReportProblemOutlinedIcon color={issues.length > 0 ? 'warning' : 'inherit'} />
                    </Badge>
                </IconButton>
            </Tooltip>
            <Dialog open={isOpen} onClose={() => setIsOpen(false)} fullWidth maxWidth="sm" data-testid="syncIssuesPanel">
                <DialogTitle className={styles.dialogTitle}>
                    Sync issues
                    <IconButton onClick={() => setIsOpen(false)} size="small" aria-label="Close">
                        <CloseIcon fontSize="small" />
                    </IconButton>
                </DialogTitle>
                <DialogContent dividers>
                    {issues.length === 0 ? (
                        <Typography variant="body2" color="text.secondary">
                            No sync issues right now.
                        </Typography>
                    ) : (
                        <List disablePadding>
                            {issues.map((issue) => (
                                <SyncIssueRow key={issue._id} issue={issue} onChanged={refetch} />
                            ))}
                        </List>
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}

interface SyncIssueRowProps {
    issue: SyncIssue;
    onChanged: () => Promise<void>;
}

function SyncIssueRow({ issue, onChanged }: SyncIssueRowProps) {
    // useTransition gives a pending flag without a hand-rolled boolean state. The Retry/Dismiss
    // buttons both route through `startAction` so concurrent clicks de-dupe automatically.
    const [isPending, startAction] = useTransition();

    function onRetry() {
        startAction(async () => {
            await retrySyncIssue(issue._id);
            await onChanged();
        });
    }

    function onDismiss() {
        startAction(async () => {
            await dismissSyncIssue(issue._id);
            await onChanged();
        });
    }

    return (
        <ListItem disableGutters className={styles.row} data-testid="syncIssueEntry">
            <Box className={styles.rowBody}>
                <Typography variant="body2" className={styles.rowTitle}>
                    {titleForOp(issue)} — {FAILURE_LABELS[issue.failureReason]}
                </Typography>
                {issue.failureDetail && (
                    <Typography variant="caption" color="text.secondary" data-testid="syncIssueDetail">
                        {issue.failureDetail}
                    </Typography>
                )}
            </Box>
            <Box className={styles.rowActions}>
                {issue.retryable && (
                    <Button size="small" variant="outlined" onClick={onRetry} disabled={isPending} data-testid="syncIssueRetry">
                        Retry
                    </Button>
                )}
                <Button size="small" onClick={onDismiss} disabled={isPending} data-testid="syncIssueDismiss">
                    Dismiss
                </Button>
            </Box>
        </ListItem>
    );
}
