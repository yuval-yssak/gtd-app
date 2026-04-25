import dayjs from 'dayjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import routinesDAO from '../../dataAccess/routinesDAO.js';
import { closeDataAccess, loadDataAccess } from '../../loaders/mainLoader.js';
import { cleanupByRunId } from '../harness/cleanup.js';
import { makeRunId } from '../harness/env.js';
import { cancelInstance, findInstanceByDate, modifyInstance, patchMasterEvent } from '../harness/gcal.js';
import { type SeedResult, seedFreshAccount, seedRoutine } from '../harness/seed.js';
import { linkRoutine, mintSessionCookie, triggerSync } from '../harness/sync.js';

/**
 * Section B — app-originated routine, then GCal-side change.
 *
 * The app creates the series. We then mutate it directly in Google Calendar
 * (simulating what a user would do in the GCal UI) and call `POST /calendar/integrations/:id/sync`
 * to pull changes back.
 *
 * `R.routineExceptions` is the key server-side artefact — it records the
 * overrides detected during sync.
 */
describe('B. App-originated routine, then GCal-side change', () => {
    let seed: SeedResult;
    let sessionCookie: string;
    const runId = makeRunId();

    beforeAll(async () => {
        await loadDataAccess('gtd_test_sync_audit');
        await cleanupByRunId(runId);
        seed = await seedFreshAccount();
        sessionCookie = await mintSessionCookie(seed.userId);
        console.log(`[B.audit] runId=${runId} user=${seed.userId}`);
    });

    afterAll(async () => {
        await cleanupByRunId(runId);
        await closeDataAccess();
    });

    /** Utility: find an upcoming Monday date in YYYY-MM-DD. Used to pick an instance to edit. */
    function nextWeekday(weekday: number, baseDate = dayjs()): string {
        // weekday: 0=Sun...6=Sat — matches dayjs().day()
        let d = baseDate.startOf('day');
        while (d.day() !== weekday) d = d.add(1, 'day');
        // Skip today if it's already the target day (to avoid DST-adjacent edge weirdness).
        if (d.isSame(baseDate, 'day')) d = d.add(7, 'day');
        return d.format('YYYY-MM-DD');
    }

    it('B1 — modify a single instance in GCal (time change) creates a modified exception', async () => {
        const routine = await seedRoutine({
            userId: seed.userId,
            integrationId: seed.integration._id,
            configId: seed.config._id,
            title: `${runId}-B1 WeeklyTime`,
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            timeOfDay: '09:00',
            duration: 30,
        });
        const { calendarEventId } = await linkRoutine(sessionCookie, seed.integration._id, routine._id);
        if (!calendarEventId) throw new Error('link failed');

        // Pick an upcoming Monday — instances endpoint needs a real occurrence date.
        const targetDate = nextWeekday(1);
        const instance = await findInstanceByDate(calendarEventId, targetDate);
        expect(instance, `expected an instance for ${targetDate}`).toBeTruthy();
        if (!instance) throw new Error('instance missing');

        // Shift the instance by 2 hours in GCal.
        const newStart = `${targetDate}T11:00:00`;
        const newEnd = `${targetDate}T11:30:00`;
        await modifyInstance(instance.id, { newTimeStart: newStart, newTimeEnd: newEnd, timeZone: seed.timeZone });

        const syncRes = await triggerSync(sessionCookie, seed.integration._id);
        expect(syncRes.ok).toBe(true);

        const updated = await routinesDAO.findByOwnerAndId(routine._id, seed.userId);
        const exc = updated?.routineExceptions?.find((e) => e.date === targetDate);
        expect(exc, `expected exception for ${targetDate}`).toBeTruthy();
        expect(exc?.type).toBe('modified');
        expect(exc?.newTimeStart).toContain('T11:00:00');
        expect(exc?.newTimeEnd).toContain('T11:30:00');
    });

    it('B3 — delete a single instance in GCal creates a skipped exception', async () => {
        const routine = await seedRoutine({
            userId: seed.userId,
            integrationId: seed.integration._id,
            configId: seed.config._id,
            title: `${runId}-B3 WeeklySkip`,
            rrule: 'FREQ=WEEKLY;BYDAY=TU',
            timeOfDay: '10:00',
            duration: 30,
        });
        const { calendarEventId } = await linkRoutine(sessionCookie, seed.integration._id, routine._id);
        if (!calendarEventId) throw new Error('link failed');

        const targetDate = nextWeekday(2);
        const instance = await findInstanceByDate(calendarEventId, targetDate);
        if (!instance) throw new Error('instance missing');

        await cancelInstance(instance.id);

        const syncRes = await triggerSync(sessionCookie, seed.integration._id);
        expect(syncRes.ok).toBe(true);

        const updated = await routinesDAO.findByOwnerAndId(routine._id, seed.userId);
        const exc = updated?.routineExceptions?.find((e) => e.date === targetDate);
        expect(exc?.type).toBe('skipped');
    });

    it('B4 — edit master title/description in GCal propagates to routine', async () => {
        const routine = await seedRoutine({
            userId: seed.userId,
            integrationId: seed.integration._id,
            configId: seed.config._id,
            title: `${runId}-B4 MasterEdit`,
            rrule: 'FREQ=WEEKLY;BYDAY=WE',
            timeOfDay: '14:00',
            duration: 30,
            notes: 'original',
        });
        const { calendarEventId } = await linkRoutine(sessionCookie, seed.integration._id, routine._id);
        if (!calendarEventId) throw new Error('link failed');

        const newTitle = `${runId}-B4 MasterEdit v2`;
        const newDesc = '<p>new description from gcal</p>';
        await patchMasterEvent(calendarEventId, { summary: newTitle, description: newDesc });

        const syncRes = await triggerSync(sessionCookie, seed.integration._id);
        expect(syncRes.ok).toBe(true);

        const updated = await routinesDAO.findByOwnerAndId(routine._id, seed.userId);
        expect(updated?.title).toBe(newTitle);
        // lastSyncedNotes stores the raw HTML from GCal.
        expect(updated?.lastSyncedNotes).toContain('new description');
        // template.notes stores the markdown conversion.
        expect(updated?.template?.notes ?? '').toContain('new description from gcal');
    });

    // B2 (title/notes override on an instance) requires surfacing per-instance notes/title
    // onto routineExceptions. Covered by the unit tests — adding the real-API variant here.
    it('B2 — modify a single instance title+description in GCal creates a modified exception with notes', async () => {
        const routine = await seedRoutine({
            userId: seed.userId,
            integrationId: seed.integration._id,
            configId: seed.config._id,
            title: `${runId}-B2 InstContent`,
            rrule: 'FREQ=WEEKLY;BYDAY=TH',
            timeOfDay: '15:00',
            duration: 30,
            notes: 'master notes',
        });
        const { calendarEventId } = await linkRoutine(sessionCookie, seed.integration._id, routine._id);
        if (!calendarEventId) throw new Error('link failed');

        const targetDate = nextWeekday(4);
        const instance = await findInstanceByDate(calendarEventId, targetDate);
        if (!instance) throw new Error('instance missing');

        await modifyInstance(instance.id, {
            summary: `${runId}-B2 overridden`,
            description: '<p>instance-only notes</p>',
            timeZone: seed.timeZone,
        });

        const syncRes = await triggerSync(sessionCookie, seed.integration._id);
        expect(syncRes.ok).toBe(true);

        const updated = await routinesDAO.findByOwnerAndId(routine._id, seed.userId);
        const exc = updated?.routineExceptions?.find((e) => e.date === targetDate);
        expect(exc?.type).toBe('modified');
        expect(exc?.title).toContain('overridden');
        expect(exc?.notes ?? '').toContain('instance-only notes');
    });

    it.skip('B5 — [needs-browser] change master RRULE in GCal regenerates local items', () => {});
    it.skip('B6 — [needs-browser] change master time in GCal shifts future items', () => {});
    it.skip('B7 — [needs-browser] change master duration in GCal updates timeEnd on future items', () => {});
});
