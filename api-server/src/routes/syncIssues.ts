import dayjs from 'dayjs';
import { Hono } from 'hono';
import { authenticateRequest } from '../auth/middleware.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import { buildCalendarProvider } from '../lib/buildCalendarProvider.js';
import { maybePushToGCal } from '../lib/calendarPushback.js';
import { replayRsvpOp } from '../lib/rsvpReplay.js';
import type { AuthVariables } from '../types/authTypes.js';
import type { OpFailureReason } from '../types/entities.js';

/**
 * Failure reasons that the SyncIssuesPanel can retry. Terminal failures (event deleted, uninvited)
 * cannot be made succeed by retrying — the panel only offers Dismiss for those entries.
 *
 * Source-of-truth note: this set mirrors the panel's UX contract. Adding a new `OpFailureReason`
 * enum value requires updating BOTH this set AND the client's failure-label map.
 */
const RETRYABLE_REASONS: ReadonlySet<OpFailureReason> = new Set<OpFailureReason>(['transient_exhausted', 'scope_missing', 'edit_conflict', 'calendar_missing']);

interface IssueRow {
    _id: string;
    ts: string;
    opType: string;
    entityType: string;
    entityId: string;
    failureReason: OpFailureReason;
    failureDetail: string | undefined;
    retryable: boolean;
}

/**
 * Pure projection of a persisted op into the panel-facing row. Kept tiny so the route handler
 * reads top-to-bottom; the only branching is on the failureReason → retryable lookup.
 */
function toIssueRow(op: {
    _id: string;
    ts: string;
    opType: string;
    entityType: string;
    entityId: string;
    failureReason?: OpFailureReason;
    failureDetail?: string;
}): IssueRow {
    // findArray's filter (`syncFailed: true`) guarantees the row was marked failed, but
    // `failureReason` is technically optional on the schema — fall back to `terminal` so a
    // malformed row still surfaces with a Dismiss-only affordance instead of crashing the panel.
    const reason: OpFailureReason = op.failureReason ?? 'terminal';
    return {
        _id: op._id,
        ts: op.ts,
        opType: op.opType,
        entityType: op.entityType,
        entityId: op.entityId,
        failureReason: reason,
        failureDetail: op.failureDetail,
        retryable: RETRYABLE_REASONS.has(reason),
    };
}

export const syncIssuesRoutes = new Hono<{ Variables: AuthVariables }>()
    // ---------------------------------------------------------------------------
    // GET /sync/issues — list failed ops surfaced in the SyncIssuesPanel
    // ---------------------------------------------------------------------------
    // Scoped to the session user via `{ user, syncFailed: true }`. A tenant-isolation regression
    // here would let a logged-in attacker enumerate another user's failed ops; the test suite
    // pins this explicitly. Sort by `failedTs` desc when present, falling back to `ts` so legacy
    // rows without `failedTs` still get a deterministic ordering.
    .get('/', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const ops = await operationsDAO.findArray({ user: user.id, syncFailed: true }, { sort: { failedTs: -1, ts: -1 } });
        return c.json({ issues: ops.map(toIssueRow) });
    })

    // ---------------------------------------------------------------------------
    // POST /sync/issues/:opId/dismiss — clear an entry from the panel
    // ---------------------------------------------------------------------------
    // For terminal failures, the responseStatus has already been reverted server-side (rsvpReplay).
    // For retryable failures, dismissing means "I don't care about this anymore" — the op row
    // disappears from /sync/issues and the user accepts the GCal-side state drift.
    .post('/:opId/dismiss', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const opId = c.req.param('opId');
        // Owner-scoped delete: deleteOne with `{ _id, user }` so a forged opId for another user's
        // op is a silent no-op rather than a cross-tenant write. matchedCount drives the 404.
        const result = await operationsDAO.deleteOne(opId, user.id);
        if (!result.deletedCount) {
            return c.json({ error: 'Issue not found' }, 404);
        }
        return c.json({ ok: true });
    })

    // ---------------------------------------------------------------------------
    // POST /sync/issues/:opId/retry — re-run a retryable op's GCal-side effect
    // ---------------------------------------------------------------------------
    // Loads the persisted op, validates it's still retryable, clears its failure markers, and
    // re-runs the appropriate replay path. On success the op row is deleted (panel entry clears);
    // on failure the same replay path re-marks `syncFailed` and the row re-appears on next fetch.
    .post('/:opId/retry', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const opId = c.req.param('opId');
        const op = await operationsDAO.findOne({ _id: opId, user: user.id });
        if (!op) {
            return c.json({ error: 'Issue not found' }, 404);
        }
        if (!op.syncFailed) {
            return c.json({ error: 'Op is not in failed state' }, 400);
        }
        const reason = op.failureReason ?? 'terminal';
        if (!RETRYABLE_REASONS.has(reason)) {
            return c.json({ error: 'Op is not retryable' }, 400);
        }

        // Clear failure markers + bump ts BEFORE re-running so the replay path's `markOpFailed`
        // calls land on a clean row (no stale failureReason from the prior attempt). Bumping ts
        // also makes the retried op sort to the top of the operations log so other devices learn
        // about the re-attempt on their next pull.
        const now = dayjs().toISOString();
        await operationsDAO.updateOne(
            { _id: opId, user: user.id },
            { $set: { ts: now }, $unset: { syncFailed: '', failureReason: '', failureDetail: '', failedTs: '' } },
        );

        // Reload the post-update op so the replay path sees the cleared markers + fresh ts.
        const refreshed = await operationsDAO.findOne({ _id: opId, user: user.id });
        if (!refreshed) {
            return c.json({ error: 'Issue disappeared mid-retry' }, 404);
        }

        if (refreshed.opType === 'rsvp') {
            await replayRsvpOp(user.id, refreshed, buildCalendarProvider);
        } else {
            // update / create on a calendar entity — re-fire the generic pushback. Awaited (not
            // fire-and-forget) so the response can report success/failure to the panel.
            await maybePushToGCal(refreshed, buildCalendarProvider);
        }

        // Re-read the post-replay op. If `syncFailed` is back, the retry failed again — leave the
        // row in place so the panel re-surfaces it. Otherwise delete the row (success).
        const postReplay = await operationsDAO.findOne({ _id: opId, user: user.id });
        if (postReplay?.syncFailed) {
            return c.json({ ok: false, failureReason: postReplay.failureReason }, 200);
        }
        await operationsDAO.deleteOne(opId, user.id);
        return c.json({ ok: true });
    });
