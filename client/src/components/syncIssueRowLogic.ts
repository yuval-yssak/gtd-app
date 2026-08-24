import dayjs from 'dayjs';
import type { SyncIssue, SyncIssueFailureReason } from '../api/syncApi';
import type { EntityType } from '../types/MyDB';

/**
 * Maps a `failureReason` to a single user-friendly line. The label captures both the action that
 * failed and the *why* — terminal reasons read as a finality ("Event was cancelled…"), retryable
 * ones leave the door open ("could not reach Google Calendar…"). Source-of-truth note: this map
 * mirrors the server's `OpFailureReason` enum; adding a new reason there requires a label here too.
 */
export const FAILURE_LABELS: Record<SyncIssueFailureReason, string> = {
    transient_exhausted: "Couldn't reach Google Calendar — please retry.",
    scope_missing: 'Google needs additional permissions to complete this change.',
    calendar_missing: "The target calendar isn't available anymore — pick another or retry.",
    edit_conflict: 'The event changed in Google Calendar — retry to reapply the change.',
    terminal: 'Event was cancelled by the organizer or removed in Google Calendar.',
    entity_missing: 'This item no longer exists (it was deleted or moved to another account), so the change was not applied.',
};

/** What failed, as a short verb phrase — keeps the panel scannable when several rows share a label. */
function failedActionLabel(op: SyncIssue): string {
    if (op.opType === 'rsvp') {
        return 'RSVP failed';
    }
    if (op.opType === 'update') {
        return 'Update failed';
    }
    return `${op.opType} failed`;
}

/** Panel-facing entity-type labels. Partial + fallback so a server type this build doesn't know
 *  about yet (forward-compat) still renders as its raw value instead of crashing the row. */
const ENTITY_TYPE_LABELS: Partial<Record<EntityType, string>> = {
    item: 'Item',
    routine: 'Routine',
    person: 'Person',
    workContext: 'Work context',
    reviewInbox: 'Review inbox',
};

function entityTypeLabel(entityType: EntityType): string {
    return ENTITY_TYPE_LABELS[entityType] ?? entityType;
}

/**
 * Pure presentation of a SyncIssue row — extracted (same pattern as `calendarRowMetaLogic`) so the
 * derived strings are unit-testable render-free. `failedTs` is preferred over `ts` because retry
 * bumps `ts`; an unparseable timestamp degrades to 'unknown time' rather than "Invalid Date".
 */
export function syncIssueRowText(issue: SyncIssue) {
    const failedAt = dayjs(issue.failedTs ?? issue.ts);
    const timeLabel = failedAt.isValid() ? failedAt.format('MMM D, YYYY HH:mm') : 'unknown time';
    return {
        title: issue.entityTitle?.trim() ? `“${issue.entityTitle}”` : entityTypeLabel(issue.entityType),
        reason: `${failedActionLabel(issue)} — ${FAILURE_LABELS[issue.failureReason]}`,
        meta: `${entityTypeLabel(issue.entityType)} · ${timeLabel}`,
        // Raw server detail only for retryable failures — there it carries the actual provider
        // error worth reading. For terminal reasons it just restates the label.
        showDetail: issue.retryable && Boolean(issue.failureDetail),
    };
}
