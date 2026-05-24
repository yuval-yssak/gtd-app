/**
 * Window-level event name the SyncIssuesPanel listens for to refetch. Kept in its own module so
 * the dispatcher side (sync layer) can import it without pulling in the panel's MUI dependencies.
 */
export const SYNC_ISSUES_REFRESH_EVENT = 'gtd:sync-issues-refresh';

/** Fires the refresh event. Safe to call from any module — listener is a no-op when not mounted. */
export function dispatchSyncIssuesRefresh(): void {
    window.dispatchEvent(new CustomEvent(SYNC_ISSUES_REFRESH_EVENT));
}
