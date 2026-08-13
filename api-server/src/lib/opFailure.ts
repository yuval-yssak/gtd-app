import dayjs from 'dayjs';
import operationsDAO from '../dataAccess/operationsDAO.js';
import type { OpFailureReason } from '../types/entities.js';

/** failureDetail is shown in the SyncIssuesPanel — cap so a giant stack trace doesn't blow up the row. */
export const FAILURE_DETAIL_MAX_LEN = 200;

/**
 * Marks a persisted op row failed in place. Shared by every replay/pushback path that surfaces
 * failures through the SyncIssuesPanel (RSVP replay, GCal create-on-reassign, retry re-fires).
 */
export async function markOpFailed(opId: string, reason: OpFailureReason, detail: string): Promise<void> {
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
