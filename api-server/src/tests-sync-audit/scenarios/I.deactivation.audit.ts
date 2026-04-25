import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import routinesDAO from '../../dataAccess/routinesDAO.js';
import { closeDataAccess, loadDataAccess } from '../../loaders/mainLoader.js';
import { cleanupByRunId } from '../harness/cleanup.js';
import { makeRunId } from '../harness/env.js';
import { deleteMasterEvent } from '../harness/gcal.js';
import { type SeedResult, seedFreshAccount, seedRoutine } from '../harness/seed.js';
import { linkRoutine, mintSessionCookie, triggerSync } from '../harness/sync.js';

/**
 * Section I — routine deactivation via GCal master delete.
 *
 * Ground truth: `routinesDAO.active` must flip to false after a sync that
 * observes the GCal master as cancelled.
 */
describe('I. Routine deactivation (GCal master deleted)', () => {
    let seed: SeedResult;
    let sessionCookie: string;
    const runId = makeRunId();

    beforeAll(async () => {
        await loadDataAccess('gtd_test_sync_audit');
        await cleanupByRunId(runId);
        seed = await seedFreshAccount();
        sessionCookie = await mintSessionCookie(seed.userId);
        console.log(`[I.audit] runId=${runId} user=${seed.userId}`);
    });

    afterAll(async () => {
        await cleanupByRunId(runId);
        await closeDataAccess();
    });

    it('I1 — master event deleted in GCal deactivates the routine', async () => {
        const routine = await seedRoutine({
            userId: seed.userId,
            integrationId: seed.integration._id,
            configId: seed.config._id,
            title: `${runId}-I1 ToBeKilled`,
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            timeOfDay: '09:00',
            duration: 30,
        });
        const { calendarEventId } = await linkRoutine(sessionCookie, seed.integration._id, routine._id);
        if (!calendarEventId) throw new Error('link failed');

        const beforeSync = await routinesDAO.findByOwnerAndId(routine._id, seed.userId);
        expect(beforeSync?.active).toBe(true);

        await deleteMasterEvent(calendarEventId);

        const syncRes = await triggerSync(sessionCookie, seed.integration._id);
        expect(syncRes.ok).toBe(true);

        const afterSync = await routinesDAO.findByOwnerAndId(routine._id, seed.userId);
        expect(afterSync?.active).toBe(false);
    });
});
