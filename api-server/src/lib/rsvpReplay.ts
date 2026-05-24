import dayjs from 'dayjs';
import type { CalendarProvider } from '../calendarProviders/CalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import type { CalendarIntegrationInterface, GCalResponseStatus, ItemInterface, OperationInterface, OpFailureReason, RsvpOpPayload } from '../types/entities.js';
import { categorizeGCalError } from './gcalErrorCategorization.js';
import { retryWithBackoff } from './gcalRetry.js';
import { applyRsvpToAttendees, resolveSyncConfigForItem } from './rsvpHelpers.js';

type ProviderFactory = (integration: CalendarIntegrationInterface, userId: string) => CalendarProvider;

/** failureDetail is shown in the SyncIssuesPanel — cap so a giant stack trace doesn't blow up the row. */
const FAILURE_DETAIL_MAX_LEN = 200;

/**
 * Replays an `opType: 'rsvp'` operation: pushes the user's responseStatus to GCal and updates the
 * local item to match. Mirrors the online-fast-path RSVP endpoint (calendar.ts) but runs from the
 * `/sync/push` replay pipeline so offline RSVPs land on GCal once the client reconnects.
 *
 * Failure modes are categorized by `categorizeGCalError`:
 *   - terminal (404/410/403): mark op `syncFailed` AND revert any optimistic local responseStatus
 *     change. The "prior" value is read off the item just before the GCal call — see the multi-op
 *     race note inline below.
 *   - scope_missing / edit_conflict / calendar_missing: mark op `syncFailed` so the SyncIssuesPanel
 *     can surface a Reconnect / Pick calendar / Retry remediation. No local revert (the next pull
 *     surfaces the GCal-canonical state to all devices).
 *   - transient_exhausted (5xx/429/network, after 3 retries): same as recoverable — mark `syncFailed`
 *     with Retry semantics.
 *
 * Pre-conditions that don't go through the categorizer (item missing, no longer a calendar item,
 * integration deleted) short-circuit to `'terminal'` with a hand-written detail string — the
 * SyncIssuesPanel can't actually retry those, just Dismiss.
 *
 * Always resolves — never throws. The persisted op row is the only place failures are surfaced;
 * the caller (applyAndPublishOperation) is fire-and-forget after this returns.
 */
export async function replayRsvpOp(userId: string, op: OperationInterface, buildProvider: ProviderFactory): Promise<void> {
    if (op.opType !== 'rsvp' || !op.rsvp) {
        return;
    }
    const { rsvp } = op;
    const item = await itemsDAO.findByOwnerAndId(rsvp.itemId, userId);
    // Routine-instance items carry calendarInstanceEventId in place of calendarEventId — the op's
    // own rsvp.calendarEventId snapshot already pins whichever id the issuing client saw, so the
    // pre-flight just needs the item to be calendar-status with a live integration id.
    if (!item || item.status !== 'calendar' || !item.calendarIntegrationId) {
        await markOpFailed(op._id, 'terminal', 'item missing or no longer calendar');
        return;
    }
    const integration = await calendarIntegrationsDAO.findByOwnerAndIdDecrypted(item.calendarIntegrationId, userId);
    if (!integration) {
        await markOpFailed(op._id, 'terminal', 'calendar integration removed');
        return;
    }
    const config = await resolveSyncConfigForItem(item, integration._id, userId);
    if (!config) {
        await markOpFailed(op._id, 'calendar_missing', 'no sync config found for calendar');
        return;
    }
    await pushRsvpToGCal({ userId, op, rsvp, item, integration, config, buildProvider });
}

interface PushArgs {
    userId: string;
    op: OperationInterface;
    rsvp: RsvpOpPayload;
    item: ItemInterface;
    integration: CalendarIntegrationInterface;
    config: { _id: string; calendarId: string };
    buildProvider: ProviderFactory;
}

/**
 * Executes the GCal PATCH (with retry on transient failures) and persists the resulting state.
 * Splits the orchestration out of `replayRsvpOp` so the latter reads top-to-bottom as a guarded
 * pre-flight followed by one push call.
 *
 * Note on the "prior responseStatus" stash: this is the value on the server document *right now*,
 * which equals the local-device value only if no concurrent `update` op (carrying the new
 * responseStatus in its snapshot) was applied between the optimistic local change and this replay.
 * For the common single-device offline-RSVP-then-reconnect case, the stash is the pre-RSVP value —
 * exactly what we want to revert to on terminal failure. For the rare update-then-rsvp interleaving,
 * the stash equals the new value and the "revert" is a no-op, which is the best we can do without
 * walking the per-entity op history.
 */
async function pushRsvpToGCal(args: PushArgs): Promise<void> {
    const { userId, op, rsvp, item, integration, config, buildProvider } = args;
    const provider = buildProvider(integration, userId);
    const priorResponseStatus = item.responseStatus;
    // Re-derive the GCal event id at replay time. For single events `item.calendarEventId` is
    // authoritative; for routine-instance items `item.calendarInstanceEventId` is the current
    // GCal id even if a since-applied master-time edit invalidated the original id captured in
    // `rsvp.calendarEventId`. Falls back to the op's snapshot when both are absent (legacy ops).
    const eventId = item.calendarEventId ?? item.calendarInstanceEventId ?? rsvp.calendarEventId;
    // Stamp `now` BEFORE the GCal call (including retries). The online endpoint does the same;
    // stamping after the await lets slow PATCH + webhook latency exceed ECHO_WINDOW_SECONDS, and
    // the webhook-arrived inbound is then mis-classified as an external change and re-applied.
    // With retries this gap can reach ~30s; pre-stamping anchors on push-initiation time.
    const now = dayjs().toISOString();
    try {
        const myEmail = await provider.getMyEmail();
        const nextAttendees = applyRsvpToAttendees(item.attendees ?? [], myEmail, rsvp.responseStatus);
        await retryWithBackoff(
            () => provider.patchEventAttendees(config.calendarId, eventId, nextAttendees, { sendUpdates: 'all' }),
            (err) => categorizeGCalError(err) === 'transient_exhausted',
        );
        await commitRsvpLocally(item, nextAttendees, rsvp.responseStatus, now);
    } catch (err) {
        const reason = categorizeGCalError(err);
        const detail = err instanceof Error ? err.message.slice(0, FAILURE_DETAIL_MAX_LEN) : 'unknown error';
        await markOpFailed(op._id, reason, detail);
        // Terminal failures (event deleted / uninvited): if we changed responseStatus locally on a
        // prior op, revert it so the panel-dismiss UX is honest ("Your RSVP wasn't saved"). Skipped
        // for recoverable reasons since the user may retry and we don't want to flip the chip twice.
        if (reason === 'terminal') {
            await revertLocalResponseStatus(userId, item._id, priorResponseStatus, rsvp.responseStatus);
        }
    }
}

/** Persists the post-push item state. Mirrors the online-fast-path endpoint's replaceById call. */
async function commitRsvpLocally(item: ItemInterface, attendees: ItemInterface['attendees'], responseStatus: GCalResponseStatus, now: string): Promise<void> {
    if (!item._id) {
        return;
    }
    // lastPushedToGCalTs lets the inbound webhook skip echoing this attendee patch back as an
    // external change (see calendar.ts ECHO_WINDOW_SECONDS guard).
    const updated: ItemInterface = {
        ...item,
        ...(attendees !== undefined ? { attendees } : {}),
        responseStatus,
        lastPushedToGCalTs: now,
        updatedTs: now,
    };
    await itemsDAO.replaceById(item._id, updated);
}

/**
 * Reverts the item's `responseStatus` to its pre-replay value and bumps `updatedTs` so the next
 * pull picks it up. Per the plan, we don't emit a dedicated revert op — the bumped updatedTs is
 * enough for the standard pull diff to surface the rollback to all devices.
 *
 * No-op when prior and attempted statuses are equal: this happens in the rare update-then-rsvp
 * interleaving where an interleaved `update` op already wrote the new responseStatus to the item
 * before this rsvp replay ran, so the "prior" stash equals the new value. Logged so we can
 * observe the silent no-op in the field if users report a stuck chip after a terminal failure.
 */
async function revertLocalResponseStatus(
    userId: string,
    itemId: string | undefined,
    priorResponseStatus: GCalResponseStatus | undefined,
    attemptedResponseStatus: GCalResponseStatus,
): Promise<void> {
    if (!itemId) {
        return;
    }
    if (priorResponseStatus === attemptedResponseStatus) {
        console.debug(
            `[rsvp-replay] revert is a no-op | itemId=${itemId} priorResponseStatus=${priorResponseStatus} attempted=${attemptedResponseStatus} (likely an interleaved update op overwrote the prior state)`,
        );
        return;
    }
    const now = dayjs().toISOString();
    if (priorResponseStatus === undefined) {
        await itemsDAO.updateOne({ _id: itemId, user: userId }, { $unset: { responseStatus: '' }, $set: { updatedTs: now } });
        return;
    }
    await itemsDAO.updateOne({ _id: itemId, user: userId }, { $set: { responseStatus: priorResponseStatus, updatedTs: now } });
}

/** Marks a persisted op row failed in place. Used by all failure paths in `replayRsvpOp`. */
async function markOpFailed(opId: string, reason: OpFailureReason, detail: string): Promise<void> {
    const now = dayjs().toISOString();
    await operationsDAO.updateOne(
        { _id: opId },
        {
            $set: {
                syncFailed: true,
                failureReason: reason,
                failureDetail: detail.slice(0, FAILURE_DETAIL_MAX_LEN),
                failedTs: now,
            },
        },
    );
}
