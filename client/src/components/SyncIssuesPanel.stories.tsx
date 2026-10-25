import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { SyncIssue } from '../api/syncApi';
import { SyncIssuesPanel } from './SyncIssuesPanel';

const retryableIssue: SyncIssue = {
    _id: 'op-1',
    ts: '2026-10-20T09:15:00.000Z',
    failedTs: '2026-10-20T09:15:00.000Z',
    opType: 'update',
    entityType: 'item',
    entityId: 'item-1',
    entityTitle: 'Quarterly planning meeting',
    failureReason: 'transient_exhausted',
    failureDetail: 'Rate limit exceeded (403 rateLimitExceeded)',
    retryable: true,
};

const terminalIssue: SyncIssue = {
    _id: 'op-2',
    ts: '2026-10-21T14:40:00.000Z',
    failedTs: '2026-10-21T14:40:00.000Z',
    opType: 'rsvp',
    entityType: 'routine',
    entityId: 'routine-1',
    entityTitle: 'Weekly 1:1 with Dana',
    failureReason: 'terminal',
    retryable: false,
};

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const urlOf = (input: RequestInfo | URL) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

/**
 * Serves the sync-issues endpoints from an in-memory list (the panel fetches on mount, with no
 * other seam). Dismiss / retry remove the row, as the server does. Returns the restore function.
 */
function stubSyncIssuesApi(initialIssues: SyncIssue[]) {
    const realFetch = window.fetch;
    const state = { issues: initialIssues };
    window.fetch = async (input, init) => {
        const url = urlOf(input);
        if (!url.includes('/sync/issues')) {
            return realFetch(input, init);
        }
        const actedOnId = url.match(/\/sync\/issues\/([^/]+)\/(?:dismiss|retry)/)?.[1];
        if (actedOnId) {
            state.issues = state.issues.filter((issue) => issue._id !== actedOnId);
            return jsonResponse({ ok: true });
        }
        return jsonResponse({ issues: state.issues });
    };
    return () => {
        window.fetch = realFetch;
    };
}

const openPanel: Story['play'] = async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByTestId('syncIssuesBadge'));
    await waitFor(() => expect(within(document.body).getByTestId('syncIssuesPanel')).toBeVisible());
};

const meta = {
    title: 'Components/SyncIssuesPanel',
    component: SyncIssuesPanel,
} satisfies Meta<typeof SyncIssuesPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No failed ops — the panel renders nothing at all (no badge in the app shell). */
export const Empty: Story = {
    beforeEach: () => stubSyncIssuesApi([]),
};

/** Failed ops exist — the warning badge carries the live count. */
export const WithIssues: Story = {
    beforeEach: () => stubSyncIssuesApi([retryableIssue, terminalIssue]),
    play: async ({ canvasElement }) => {
        await waitFor(() => expect(within(canvasElement).getByTestId('syncIssuesBadge')).toBeVisible());
    },
};

/** The badge was clicked — one row per failure: Retry + detail for retryable reasons, Dismiss only for terminal ones. */
export const DetailOpen: Story = {
    beforeEach: () => stubSyncIssuesApi([retryableIssue, terminalIssue]),
    play: openPanel,
};

/** The last issue was dismissed while the dialog was open — it stays open with the all-clear line. */
export const AllResolved: Story = {
    beforeEach: () => stubSyncIssuesApi([terminalIssue]),
    play: async (context) => {
        await openPanel(context);
        const panel = within(document.body).getByTestId('syncIssuesPanel');
        await userEvent.click(within(panel).getByTestId('syncIssueDismiss'));
        await waitFor(() => expect(within(panel).getByText('No sync issues right now.')).toBeVisible());
    },
};
