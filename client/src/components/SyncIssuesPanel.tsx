import { TriangleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { dismissSyncIssue, fetchSyncIssues, retrySyncIssue, type SyncIssue } from '../api/syncApi';
import { SYNC_ISSUES_REFRESH_EVENT } from '../contexts/syncIssuesEvents';
import { Badge, Button, Dialog, DialogContent, DialogTitle, IconButton, Text, Tooltip } from '../designSystem';
import { useOnline } from '../hooks/useOnline';
import styles from './SyncIssuesPanel.module.css';
import { syncIssueRowText } from './syncIssueRowLogic';

/** Polling fallback (ms) — covers the case where no sync activity has fired in a while. */
const POLL_INTERVAL_MS = 30_000;

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
    const countLabel = `${issues.length} sync issue${issues.length === 1 ? '' : 's'}`;

    return (
        <>
            <Tooltip title={countLabel}>
                <IconButton
                    size="sm"
                    tone={issues.length > 0 ? 'warning' : 'neutral'}
                    aria-label={countLabel}
                    onClick={() => setIsOpen(true)}
                    data-testid="syncIssuesBadge"
                >
                    <Badge count={issues.length} tone="error">
                        <TriangleAlert />
                    </Badge>
                </IconButton>
            </Tooltip>
            <Dialog open={isOpen} onClose={() => setIsOpen(false)} fullWidth size="sm" data-testid="syncIssuesPanel">
                <DialogTitle className={styles.dialogTitle}>
                    Sync issues
                    <IconButton onClick={() => setIsOpen(false)} size="sm" aria-label="Close">
                        <X />
                    </IconButton>
                </DialogTitle>
                <DialogContent className={styles.content}>
                    {issues.length === 0 ? (
                        <Text variant="bodySm" tone="secondary">
                            No sync issues right now.
                        </Text>
                    ) : (
                        <ul className={styles.list}>
                            {issues.map((issue) => (
                                <SyncIssueRow key={issue._id} issue={issue} onChanged={refetch} />
                            ))}
                        </ul>
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
    const rowText = syncIssueRowText(issue);

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
        <li className={styles.row} data-testid="syncIssueEntry">
            <div className={styles.rowBody}>
                <Text variant="bodySm" weight="medium" data-testid="syncIssueTitle">
                    {rowText.title}
                </Text>
                <Text variant="bodySm" tone="secondary">
                    {rowText.reason}
                </Text>
                <Text variant="caption" tone="secondary" data-testid="syncIssueMeta">
                    {rowText.meta}
                </Text>
                {rowText.showDetail && (
                    <Text variant="caption" tone="secondary" data-testid="syncIssueDetail">
                        {issue.failureDetail}
                    </Text>
                )}
            </div>
            <div className={styles.rowActions}>
                {issue.retryable && (
                    <Button size="sm" variant="outline" onClick={onRetry} disabled={isPending} data-testid="syncIssueRetry">
                        Retry
                    </Button>
                )}
                <Button size="sm" onClick={onDismiss} disabled={isPending} data-testid="syncIssueDismiss">
                    Dismiss
                </Button>
            </div>
        </li>
    );
}
