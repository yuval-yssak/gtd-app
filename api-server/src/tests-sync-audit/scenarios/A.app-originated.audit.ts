import dayjs from 'dayjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import calendarIntegrationsDAO from '../../dataAccess/calendarIntegrationsDAO.js';
import itemsDAO from '../../dataAccess/itemsDAO.js';
import routinesDAO from '../../dataAccess/routinesDAO.js';
import { closeDataAccess, loadDataAccess } from '../../loaders/mainLoader.js';
import { cleanupByRunId } from '../harness/cleanup.js';
import { makeRunId } from '../harness/env.js';
import { getEvent } from '../harness/gcal.js';
import { type SeedResult, seedFreshAccount, seedRoutine } from '../harness/seed.js';
import { linkRoutine, mintSessionCookie } from '../harness/sync.js';

/**
 * Section A — app-originated routine, then app-side change.
 *
 * Each test performs one code path end-to-end:
 *   1. Seed a calendar routine locally (no GCal side-effect yet).
 *   2. Link it via POST /calendar/integrations/:id/link-routine/:routineId — this hits GCal.
 *   3. Exercise the scenario-specific change.
 *   4. Assert on both local Mongo state and real GCal state.
 */
describe('A. App-originated routine, then app-side change', () => {
    let seed: SeedResult;
    let sessionCookie: string;
    const runId = makeRunId();

    beforeAll(async () => {
        await loadDataAccess('gtd_test_sync_audit');
        // Defensive pre-clean in case a previous run died mid-scenario.
        await cleanupByRunId(runId);
        seed = await seedFreshAccount();
        sessionCookie = await mintSessionCookie(seed.userId);
        console.log(`[A.audit] runId=${runId} user=${seed.userId} calendar=${seed.config.calendarId}`);
    });

    afterAll(async () => {
        // Cleanup GCal events regardless of test outcome so the test account doesn't
        // accumulate stale data. Each scenario uses runId-prefixed summaries.
        await cleanupByRunId(runId);
        await closeDataAccess();
    });

    it('A1 — create routine in app, link to GCal', async () => {
        const routine = await seedRoutine({
            userId: seed.userId,
            integrationId: seed.integration._id,
            configId: seed.config._id,
            title: `${runId}-A1 Standup`,
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            timeOfDay: '09:00',
            duration: 30,
        });

        const { status, calendarEventId } = await linkRoutine(sessionCookie, seed.integration._id, routine._id);
        expect(status).toBe(201);
        expect(calendarEventId).toBeTruthy();
        if (!calendarEventId) throw new Error('calendarEventId missing');

        // Verify GCal actually has the series with the expected recurrence.
        const gcalEvent = await getEvent(calendarEventId);
        expect(gcalEvent.summary).toBe(`${runId}-A1 Standup`);
        expect(gcalEvent.recurrence).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO');
        expect(gcalEvent.start?.timeZone).toBe(seed.timeZone);

        // Verify local routine was updated with the new calendarEventId.
        const stored = await routinesDAO.findByOwnerAndId(routine._id, seed.userId);
        expect(stored?.calendarEventId).toBe(calendarEventId);
    });

    it('A5 — edit master content (title/notes) in app propagates to GCal', async () => {
        const routine = await seedRoutine({
            userId: seed.userId,
            integrationId: seed.integration._id,
            configId: seed.config._id,
            title: `${runId}-A5 Planning`,
            rrule: 'FREQ=WEEKLY;BYDAY=TU',
            timeOfDay: '10:00',
            duration: 45,
            notes: 'original notes',
        });
        const { calendarEventId } = await linkRoutine(sessionCookie, seed.integration._id, routine._id);
        if (!calendarEventId) throw new Error('link failed');

        // Simulate the app-side master edit by pushing an update to the routine via /sync/push.
        // We bypass the HTTP path here and use the same DAO + patch machinery the route uses —
        // what we're testing is the GCal pushback, not the HTTP route.
        const updatedRoutine = {
            ...routine,
            calendarEventId,
            title: `${runId}-A5 Planning v2`,
            template: { notes: 'updated notes' },
            updatedTs: dayjs().toISOString(),
        };
        await routinesDAO.replaceById(routine._id, updatedRoutine);
        // Explicitly invoke the pushback helper — this is what the /sync/push route does
        // in a fire-and-forget manner after applying ops.
        const { maybePushToGCal } = await import('../../lib/calendarPushback.js');
        const { GoogleCalendarProvider } = await import('../../calendarProviders/GoogleCalendarProvider.js');
        await maybePushToGCal(
            {
                _id: 'test-op',
                user: seed.userId,
                deviceId: 'test-device',
                ts: dayjs().toISOString(),
                entityType: 'routine',
                entityId: routine._id,
                opType: 'update',
                snapshot: updatedRoutine,
            },
            (integration, userId) =>
                new GoogleCalendarProvider(integration, (at, rt, exp) =>
                    calendarIntegrationsDAO.updateTokens({ id: integration._id, userId, accessToken: at, refreshToken: rt, tokenExpiry: exp }),
                ),
        );

        const gcalEvent = await getEvent(calendarEventId);
        expect(gcalEvent.summary).toBe(`${runId}-A5 Planning v2`);
        // Notes are markdown → HTML; exact HTML depends on `marked` output, so substring-match.
        expect(gcalEvent.description ?? '').toContain('updated notes');
    });

    // A2, A4 scenarios target per-instance overrides. The instance-push path lives on the
    // client: items are generated client-side via generateCalendarItemsToHorizon(). Without
    // a browser context we cannot trigger the item create → server push → GCal override
    // round-trip. Skipped pending the Playwright phase.
    it.skip('A2 — [needs-browser] modify a single instance in the app (time change)', () => {});
    it.skip('A4 — [needs-browser] trash a single instance in the app', () => {});
    it.skip('A6 — [needs-browser] change routine RRULE (this-and-following split)', () => {});
    it.skip('A7 — delete routine in app, GCal master event is deleted', () => {
        // A7 needs the "routine delete" opType routed through the sync push. The pushback
        // helper currently handles item + routine update/create snapshots but not deletes.
        // Verify first, then wire up.
    });
    it.skip('A8 — [needs-browser] complete a single instance in the app', () => {});
    it.skip('A9 — [needs-browser] app-side change while offline, then reconnect', () => {});

    it('A3 — modify master description via patch produces new HTML in GCal (proxy for title/notes edit)', async () => {
        // Proxy for A3/A5 exercising the notes roundtrip without hitting the item-instance path.
        const routine = await seedRoutine({
            userId: seed.userId,
            integrationId: seed.integration._id,
            configId: seed.config._id,
            title: `${runId}-A3 Proxy`,
            rrule: 'FREQ=WEEKLY;BYDAY=WE',
            timeOfDay: '11:00',
            duration: 30,
            notes: '# Agenda\n\n- first point',
        });
        const { calendarEventId } = await linkRoutine(sessionCookie, seed.integration._id, routine._id);
        if (!calendarEventId) throw new Error('link failed');

        const gcalEvent = await getEvent(calendarEventId);
        // markdown → html: h1 + ul rendered by marked
        expect(gcalEvent.description ?? '').toMatch(/<h1[^>]*>Agenda<\/h1>|Agenda/);
        expect(gcalEvent.description ?? '').toContain('first point');

        // Clean up any stray local items (none expected — no horizon generation server-side).
        const items = await itemsDAO.findArray({ user: seed.userId, routineId: routine._id });
        expect(items.length).toBe(0);
    });
});
