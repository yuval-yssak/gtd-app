import { deleteEvent, listEventsByPrefix } from './gcal.js';

/**
 * Deletes every event in the test calendar whose summary starts with the run id.
 * Idempotent — safe to call from afterAll() even if individual scenarios raised.
 *
 * Called at both start (defensive, in case a previous run died mid-scenario) and
 * end of the run.
 */
export async function cleanupByRunId(runId: string): Promise<{ deleted: number }> {
    const events = await listEventsByPrefix(runId);

    // Delete masters first so their instances don't re-appear as orphans.
    const masters = events.filter((e) => !e.recurringEventId);
    const instances = events.filter((e) => e.recurringEventId);

    let deleted = 0;
    for (const e of masters) {
        await deleteEvent(e.id);
        deleted += 1;
    }
    for (const e of instances) {
        // Instance cleanup — masters may have already cascaded, so 404/410 is fine.
        await deleteEvent(e.id);
        deleted += 1;
    }
    return { deleted };
}
