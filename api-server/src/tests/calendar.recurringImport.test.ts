/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import dayjs from 'dayjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { maybePushToGCal } from '../lib/calendarPushback.js';
import { bareIdsWithLiveMasterInBatch, classifyRecurringMaster, pickSplitParent } from '../routes/calendar.js';
import type { ItemInterface, RoutineInterface } from '../types/entities.js';
import {
    app,
    CANCELLED_MASTER_TITLE,
    cancelledMaster,
    expectSoleActiveRoutine,
    getUserId,
    insertIntegrationWithConfig,
    liveMaster,
    loginAsAlice,
    makeItem,
    makeOp,
    makeRoutine,
    mockBuildProvider,
    seedSplitSeries,
    useCalendarTestLifecycle,
} from './calendarTestKit.js';
import { authenticatedRequest } from './helpers.js';

useCalendarTestLifecycle();

// ─── Recurring event → routine import ─────────────────────────────────────

describe('POST /calendar/integrations/:id/sync — recurring event import', () => {
    beforeEach(() => {
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
    });

    it('creates a routine from a GCal recurring master event', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const futureTs = dayjs().add(1, 'day').toISOString();
        const endTs = dayjs().add(1, 'day').add(30, 'minute').toISOString();

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-master-1',
                    title: 'Weekly standup',
                    timeStart: futureTs,
                    timeEnd: endTs,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-master-1' });
        expect(routine).not.toBeNull();
        expect(routine!.title).toBe('Weekly standup');
        expect(routine!.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
        expect(routine!.routineType).toBe('calendar');
        expect(routine!.calendarIntegrationId).toBe('int-1');
        expect(routine!.calendarSyncConfigId).toBe('sync-config-1');
        expect(routine!.calendarItemTemplate).toBeDefined();
        expect(routine!.calendarItemTemplate!.duration).toBe(30);
        expect(routine!.active).toBe(true);

        // Operation should be recorded
        const ops = await operationsDAO.findArray({ entityId: routine!._id, entityType: 'routine' });
        expect(ops).toHaveLength(1);
        expect(ops[0]!.opType).toBe('create');
    });

    it('updates an existing routine when GCal master event is newer', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'recurring-master-2',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Old title',
                updatedTs: oldTs,
            }),
        );

        const futureTs = dayjs().add(1, 'day').toISOString();
        const endTs = dayjs().add(1, 'day').add(45, 'minute').toISOString();

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-master-2',
                    title: 'New title',
                    timeStart: futureTs,
                    timeEnd: endTs,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=DAILY'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-master-2' });
        expect(routine!.title).toBe('New title');
        expect(routine!.rrule).toBe('FREQ=DAILY');
        expect(routine!.calendarItemTemplate!.duration).toBe(45);
    });

    it('skips update when inbound GCal payload is older than the last-synced GCal state', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // The structural gate compares against `lastSyncedFromGCalTs` (the GCal-side anchor of the last
        // applied payload), NOT `updatedTs` — a self-bumped `updatedTs` must not lock GCal out. Seed an
        // anchor newer than the inbound payload to assert genuine out-of-order protection.
        const lastSyncedFromGCalTs = dayjs().toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'recurring-master-3',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Local title',
                updatedTs: lastSyncedFromGCalTs,
                lastSyncedFromGCalTs,
            }),
        );

        const futureTs = dayjs().add(1, 'day').toISOString();

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-master-3',
                    title: 'GCal title',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: dayjs().subtract(2, 'hour').toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-master-3' });
        expect(routine!.title).toBe('Local title');
    });

    it('corrects a stale-UNTIL routine even when updatedTs is newer than the GCal payload (anchor unset)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Reproduces the stale-UNTIL deadlock: a routine frozen with a past UNTIL + active:false whose
        // `updatedTs` was bumped to "now" by churn, but with no `lastSyncedFromGCalTs` anchor. Gating on
        // the anchor (epoch fallback) lets GCal re-assert the live (no-UNTIL) schedule and reactivate it.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'recurring-master-stuck',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Daily sync',
                rrule: 'FREQ=WEEKLY;WKST=SU;UNTIL=20251210T215959Z;BYDAY=MO,TU,WE',
                active: false,
                updatedTs: dayjs().toISOString(),
                lastSyncedFromGCalTs: undefined,
            }),
        );

        const futureTs = dayjs().add(1, 'day').toISOString();
        const gcalUpdated = dayjs().subtract(2, 'hour').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-master-stuck',
                    title: 'Daily sync',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: gcalUpdated,
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=MO,TU,WE'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-master-stuck' });
        expect(routine!.rrule).toBe('FREQ=WEEKLY;WKST=SU;BYDAY=MO,TU,WE');
        expect(routine!.rrule).not.toContain('UNTIL=');
        expect(routine!.active).toBe(true);
        expect(routine!.lastSyncedFromGCalTs).toBe(gcalUpdated);
    });

    it('clears retiredByGCal when a confirmed master proves the series alive again', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // A reap-retired routine (capped + paused + marked). If the user later restores the series in
        // GCal, the inbound confirmed master must both revive the routine (newlyLosesUntil) AND drop
        // the stale marker — otherwise the /maintenance heals keep treating the live routine as a
        // deliberate retirement forever.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'recurring-master-revived',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Daily sync',
                rrule: 'FREQ=WEEKLY;WKST=SU;UNTIL=20251210T215959Z;BYDAY=MO,TU,WE',
                active: false,
                retiredByGCal: true,
                lastSyncedFromGCalTs: undefined,
            }),
        );

        const futureTs = dayjs().add(1, 'day').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-master-revived',
                    title: 'Daily sync',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: dayjs().subtract(2, 'hour').toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=MO,TU,WE'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-master-revived' });
        expect(routine!.active).toBe(true);
        expect(routine!.retiredByGCal).toBeUndefined();
    });

    it('does NOT clear retiredByGCal from an out-of-order older payload', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // A notes-only change on a payload OLDER than the structural anchor rides the merge path past
        // the !structurallyNewer early return — the one reachable way a stale payload meets the marker.
        // A fresher cancellation set this marker; a stale confirmed payload must not clear it, or a
        // delayed webhook replay would strip the heal protection right after the retirement.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'recurring-master-stale-payload',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Daily sync',
                rrule: 'FREQ=WEEKLY;WKST=SU;UNTIL=20251210T215959Z;BYDAY=MO,TU,WE',
                active: false,
                retiredByGCal: true,
                updatedTs: dayjs().subtract(3, 'hour').toISOString(),
                lastSyncedFromGCalTs: dayjs().toISOString(),
                lastSyncedNotes: '<p>old</p>',
            }),
        );

        const futureTs = dayjs().add(1, 'day').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-master-stale-payload',
                    title: 'Daily sync',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    // Older than the anchor (structurallyNewer=false) but newer than local updatedTs,
                    // so the notes conflict resolves to GCal and the merge path actually runs.
                    updated: dayjs().subtract(2, 'hour').toISOString(),
                    status: 'confirmed',
                    description: '<p>new</p>',
                    recurrence: ['RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=MO,TU,WE'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-master-stale-payload' });
        // Load-bearing: proves the merge path ran (payload not rejected outright) …
        expect(routine!.template.notes).toBe('new');
        // … and yet the stale payload neither cleared the marker nor revived the routine.
        expect(routine!.retiredByGCal).toBe(true);
        expect(routine!.active).toBe(false);
        expect(routine!.rrule).toContain('UNTIL=');
    });

    it('does NOT reactivate a user-paused routine on a still-uncapped series (newlyLosesUntil guard)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // User intentionally paused this routine. Neither the local rrule nor GCal's master carries an
        // UNTIL — so `newlyLosesUntil` (which requires the LOCAL rrule to have had UNTIL) must NOT fire,
        // leaving the user's pause intact even though the inbound payload is structurally newer.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'recurring-master-paused',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Paused daily',
                rrule: 'FREQ=WEEKLY;WKST=SU;BYDAY=MO,TU,WE',
                active: false,
                lastSyncedFromGCalTs: dayjs().subtract(1, 'day').toISOString(),
            }),
        );

        const futureTs = dayjs().add(1, 'day').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-master-paused',
                    title: 'Paused daily',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=MO,TU,WE'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        expect((await routinesDAO.findOne({ calendarEventId: 'recurring-master-paused' }))?.active).toBe(false);
    });

    it('deactivates routine when GCal master event is cancelled', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const futureTs = dayjs().add(1, 'day').toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'recurring-master-4',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                active: true,
            }),
        );
        // Insert a future item belonging to this routine
        await itemsDAO.insertOne({
            _id: 'future-routine-item',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: futureTs,
            timeEnd: futureTs,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-master-4',
                    title: '',
                    timeStart: '',
                    timeEnd: '',
                    updated: dayjs().toISOString(),
                    status: 'cancelled',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-master-4' });
        expect(routine!.active).toBe(false);

        const item = await itemsDAO.findOne({ _id: 'future-routine-item' });
        expect(item!.status).toBe('trash');
    });

    it('deactivates routine when cancelled master lacks recurrence field', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-cancel-no-recurrence',
                calendarEventId: 'recurring-master-no-recurrence',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                active: true,
            }),
        );

        // Cancelled master events from incremental sync often lack the recurrence field
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-master-no-recurrence',
                    title: '',
                    timeStart: '',
                    timeEnd: '',
                    updated: dayjs().toISOString(),
                    status: 'cancelled',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ _id: 'routine-cancel-no-recurrence' });
        expect(routine!.active).toBe(false);
    });

    it('skips recurring master with echo detection', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const recentTs = dayjs().toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'recurring-master-5',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Original',
                lastPushedToGCalTs: recentTs,
                updatedTs: recentTs,
            }),
        );

        const futureTs = dayjs().add(1, 'day').toISOString();

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-master-5',
                    title: 'Changed by echo',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: dayjs().add(2, 'second').toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-master-5' });
        expect(routine!.title).toBe('Original');
    });

    it('skips recurring master with no RRULE line', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const futureTs = dayjs().add(1, 'day').toISOString();

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-no-rrule',
                    title: 'Only EXDATE',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['EXDATE:20260410T090000Z'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-no-rrule' });
        expect(routine).toBeNull();
    });

    it('does not create calendar items for recurring master events', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const futureTs = dayjs().add(1, 'day').toISOString();

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-master-6',
                    title: 'Daily sync',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=DAILY'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Should create a routine, not an item
        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-master-6' });
        expect(routine).not.toBeNull();

        const item = await itemsDAO.findOne({ calendarEventId: 'recurring-master-6' });
        expect(item).toBeNull();
    });

    it('propagates GCal master title edit to all future generated items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-title-prop',
                calendarEventId: 'master-title-prop',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Old name',
                createdTs: oldTs,
                updatedTs: oldTs,
            }),
        );

        // Three future items on different days — all should get retitled.
        const makeItem = (suffix: string, daysAhead: number): ItemInterface => ({
            _id: `item-title-${suffix}`,
            user: userId,
            status: 'calendar',
            title: 'Old name',
            routineId: 'routine-title-prop',
            timeStart: dayjs().add(daysAhead, 'day').format('YYYY-MM-DDT09:00:00'),
            timeEnd: dayjs().add(daysAhead, 'day').format('YYYY-MM-DDT09:30:00'),
            createdTs: oldTs,
            updatedTs: oldTs,
        });
        await itemsDAO.insertOne(makeItem('a', 7));
        await itemsDAO.insertOne(makeItem('b', 14));
        await itemsDAO.insertOne(makeItem('c', 21));

        // Use a Jerusalem-local 09:00 timeStart with explicit timezone offset so that
        // `extractLocalTime` round-trips to exactly "09:00" — matching the existing routine's
        // `calendarItemTemplate.timeOfDay`. Otherwise the inferred schedule would differ and the
        // update path would regenerate items instead of just propagating the title.
        const futureDate = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const gcalStart = dayjs.tz(`${futureDate}T09:00:00`, 'Asia/Jerusalem').format();
        const gcalEnd = dayjs.tz(`${futureDate}T09:30:00`, 'Asia/Jerusalem').format();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-title-prop',
                    title: 'New name',
                    timeStart: gcalStart,
                    timeEnd: gcalEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-title-prop',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const items = await itemsDAO.findArray({ routineId: 'routine-title-prop', status: 'calendar' });
        expect(items).toHaveLength(3);
        for (const item of items) {
            expect(item.title).toBe('New name');
            // IDs must be preserved — this is a rename, not a regenerate.
            expect(['item-title-a', 'item-title-b', 'item-title-c']).toContain(item._id);
        }
    });

    it('regenerates future items when GCal master rrule changes (Mon → Tue)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        // Anchor createdTs to a Monday so the rrule's DTSTART lines up with BYDAY=MO.
        const monday = dayjs().day(1).add(1, 'week').startOf('day');
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-rrule-swap',
                calendarEventId: 'master-rrule-swap',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Weekly',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                createdTs: monday.toISOString(),
                updatedTs: oldTs,
            }),
        );

        const existingItemId = 'item-rrule-existing';
        await itemsDAO.insertOne({
            _id: existingItemId,
            user: userId,
            status: 'calendar',
            title: 'Weekly',
            routineId: 'routine-rrule-swap',
            timeStart: monday.format('YYYY-MM-DDT09:00:00'),
            timeEnd: monday.format('YYYY-MM-DDT09:30:00'),
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        // GCal master edit: recurrence now on Tuesday, start shifts 1 day.
        const tuesday = monday.add(1, 'day');
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-rrule-swap',
                    title: 'Weekly',
                    timeStart: tuesday.format('YYYY-MM-DDT09:00:00'),
                    timeEnd: tuesday.format('YYYY-MM-DDT09:30:00'),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'],
                },
            ],
            nextSyncToken: 'tok-rrule-swap',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Old Monday item is trashed; fresh Tuesday items are created.
        const trashed = await itemsDAO.findOne({ _id: existingItemId });
        expect(trashed!.status).toBe('trash');

        const liveItems = await itemsDAO.findArray({ routineId: 'routine-rrule-swap', status: 'calendar' });
        expect(liveItems.length).toBeGreaterThan(0);
        for (const item of liveItems) {
            // Tuesday = day 2 of the week.
            expect(dayjs(item.timeStart).day()).toBe(2);
        }
    });

    it('regenerates future items when GCal master duration changes (30 → 60)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        const monday = dayjs().day(1).add(1, 'week').startOf('day');
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-duration-change',
                calendarEventId: 'master-duration-change',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Meeting',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                createdTs: monday.toISOString(),
                updatedTs: oldTs,
                calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            }),
        );

        await itemsDAO.insertOne({
            _id: 'item-duration-existing',
            user: userId,
            status: 'calendar',
            title: 'Meeting',
            routineId: 'routine-duration-change',
            timeStart: monday.format('YYYY-MM-DDT09:00:00'),
            timeEnd: monday.format('YYYY-MM-DDT09:30:00'),
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-duration-change',
                    title: 'Meeting',
                    timeStart: monday.format('YYYY-MM-DDT09:00:00'),
                    timeEnd: monday.format('YYYY-MM-DDT10:00:00'),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-duration',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const trashed = await itemsDAO.findOne({ _id: 'item-duration-existing' });
        expect(trashed!.status).toBe('trash');

        const liveItems = await itemsDAO.findArray({ routineId: 'routine-duration-change', status: 'calendar' });
        expect(liveItems.length).toBeGreaterThan(0);
        for (const item of liveItems) {
            const durationMin = dayjs(item.timeEnd).diff(dayjs(item.timeStart), 'minute');
            expect(durationMin).toBe(60);
        }
    });

    it('regenerates future items when GCal master timeOfDay changes (09:00 → 10:00)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        const monday = dayjs().day(1).add(1, 'week').startOf('day');
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-time-change',
                calendarEventId: 'master-time-change',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Meeting',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                createdTs: monday.toISOString(),
                updatedTs: oldTs,
                calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            }),
        );

        await itemsDAO.insertOne({
            _id: 'item-time-existing',
            user: userId,
            status: 'calendar',
            title: 'Meeting',
            routineId: 'routine-time-change',
            timeStart: monday.format('YYYY-MM-DDT09:00:00'),
            timeEnd: monday.format('YYYY-MM-DDT09:30:00'),
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        // Use Jerusalem-local 10:00 with explicit timezone so `extractLocalTime` yields "10:00".
        const gcalStart = dayjs.tz(`${monday.format('YYYY-MM-DD')}T10:00:00`, 'Asia/Jerusalem').format();
        const gcalEnd = dayjs.tz(`${monday.format('YYYY-MM-DD')}T10:30:00`, 'Asia/Jerusalem').format();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-time-change',
                    title: 'Meeting',
                    timeStart: gcalStart,
                    timeEnd: gcalEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-time',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const trashed = await itemsDAO.findOne({ _id: 'item-time-existing' });
        expect(trashed!.status).toBe('trash');

        const liveItems = await itemsDAO.findArray({ routineId: 'routine-time-change', status: 'calendar' });
        expect(liveItems.length).toBeGreaterThan(0);
        for (const item of liveItems) {
            expect(item.timeStart?.slice(11, 16)).toBe('10:00');
        }
    });

    it('preserves per-instance title overrides when GCal master title changes', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        const nextMon = dayjs().day(1).add(1, 'week').startOf('day');
        const overrideDate = nextMon.format('YYYY-MM-DD');

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-title-override',
                calendarEventId: 'master-title-override',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Old name',
                createdTs: oldTs,
                updatedTs: oldTs,
                routineExceptions: [{ date: overrideDate, type: 'modified', title: 'Special name' }],
            }),
        );

        // One regular future item (to be renamed) + one with a per-instance override (to be preserved).
        await itemsDAO.insertOne({
            _id: 'item-regular',
            user: userId,
            status: 'calendar',
            title: 'Old name',
            routineId: 'routine-title-override',
            timeStart: nextMon.add(7, 'day').format('YYYY-MM-DDT09:00:00'),
            timeEnd: nextMon.add(7, 'day').format('YYYY-MM-DDT09:30:00'),
            createdTs: oldTs,
            updatedTs: oldTs,
        });
        await itemsDAO.insertOne({
            _id: 'item-overridden',
            user: userId,
            status: 'calendar',
            title: 'Special name',
            routineId: 'routine-title-override',
            timeStart: `${overrideDate}T09:00:00`,
            timeEnd: `${overrideDate}T09:30:00`,
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        // Preserve the routine's 09:00 / 30m schedule so only title changes.
        const futureDate = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const gcalStart = dayjs.tz(`${futureDate}T09:00:00`, 'Asia/Jerusalem').format();
        const gcalEnd = dayjs.tz(`${futureDate}T09:30:00`, 'Asia/Jerusalem').format();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-title-override',
                    title: 'New name',
                    timeStart: gcalStart,
                    timeEnd: gcalEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-override',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const regular = await itemsDAO.findOne({ _id: 'item-regular' });
        expect(regular!.title).toBe('New name');
        const overridden = await itemsDAO.findOne({ _id: 'item-overridden' });
        expect(overridden!.title).toBe('Special name');
    });

    it('leaves past items untouched when GCal master title changes', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-past-items',
                calendarEventId: 'master-past-items',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Old name',
                createdTs: oldTs,
                updatedTs: oldTs,
            }),
        );

        // Past item should keep its historical title regardless of master rename.
        await itemsDAO.insertOne({
            _id: 'item-past',
            user: userId,
            status: 'calendar',
            title: 'Old name',
            routineId: 'routine-past-items',
            timeStart: dayjs().subtract(7, 'day').format('YYYY-MM-DDT09:00:00'),
            timeEnd: dayjs().subtract(7, 'day').format('YYYY-MM-DDT09:30:00'),
            createdTs: oldTs,
            updatedTs: oldTs,
        });
        await itemsDAO.insertOne({
            _id: 'item-future',
            user: userId,
            status: 'calendar',
            title: 'Old name',
            routineId: 'routine-past-items',
            timeStart: dayjs().add(7, 'day').format('YYYY-MM-DDT09:00:00'),
            timeEnd: dayjs().add(7, 'day').format('YYYY-MM-DDT09:30:00'),
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        const futureDate = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const gcalStart = dayjs.tz(`${futureDate}T09:00:00`, 'Asia/Jerusalem').format();
        const gcalEnd = dayjs.tz(`${futureDate}T09:30:00`, 'Asia/Jerusalem').format();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-past-items',
                    title: 'New name',
                    timeStart: gcalStart,
                    timeEnd: gcalEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-past',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const past = await itemsDAO.findOne({ _id: 'item-past' });
        expect(past!.title).toBe('Old name');
        const future = await itemsDAO.findOne({ _id: 'item-future' });
        expect(future!.title).toBe('New name');
    });
});

describe('cancelled master — orphaned split-successor reap', () => {
    beforeEach(() => {
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
    });

    it('retires a legacy successor sharing the bare id, trashing its future items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Legacy successor: no calendarRebasedEventId, so no master of its own will ever cancel it.
        await seedSplitSeries(userId, 'master-orphan');
        await itemsDAO.insertOne(makeItem(userId, { _id: 'item-orphan-future', title: CANCELLED_MASTER_TITLE, routineId: 'master-orphan-successor' }));

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [cancelledMaster('master-orphan')],
            nextSyncToken: 'tok-orphan',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const successor = await routinesDAO.findOne({ _id: 'master-orphan-successor' });
        expect(successor!.active).toBe(false);
        // Capped as well as paused, so `newlyLosesUntil` can revive it if GCal ever reports the series live.
        expect(successor!.rrule).toContain('UNTIL=');
        // Marked as a deliberate GCal retirement so the /maintenance heals ("Repair sync") never
        // resurrect it — without this, healStuckGCalRoutines matches the capped+paused shape and
        // regenerates every phantom item this reap just trashed.
        expect(successor!.retiredByGCal).toBe(true);
        const item = await itemsDAO.findOne({ _id: 'item-orphan-future' });
        expect(item!.status).toBe('trash');
    });

    // Pins the use of the RAW `_R` id rather than the normalized bare id: swapping them would still pass
    // the other tests here while silently sparing every genuinely-dead tail.
    it('retires a rebased successor when its OWN _R master is the one cancelled', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const rebasedId = 'master-own_R20260102T090000';
        await seedSplitSeries(userId, 'master-own', { calendarRebasedEventId: rebasedId });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [cancelledMaster(rebasedId)],
            nextSyncToken: 'tok-own',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const successor = await routinesDAO.findOne({ _id: 'master-own-successor' });
        expect(successor!.active).toBe(false);
        expect(successor!.rrule).toContain('UNTIL=');
    });

    it('spares a rebased successor when only the base segment master is cancelled', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await seedSplitSeries(userId, 'master-spare', { calendarRebasedEventId: 'master-spare_R20260102T090000' });
        await itemsDAO.insertOne(makeItem(userId, { _id: 'item-spare-future', title: CANCELLED_MASTER_TITLE, routineId: 'master-spare-successor' }));

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [cancelledMaster('master-spare')],
            nextSyncToken: 'tok-spare',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const live = await expectSoleActiveRoutine(userId, 'master-spare');
        expect(live._id).toBe('master-spare-successor');
        // The user-visible damage of a false reap is trashed items, not the flag — assert they survive.
        const item = await itemsDAO.findOne({ _id: 'item-spare-future' });
        expect(item!.status).toBe('calendar');
    });

    // Same-batch guard 1 (anchor-less successor): a full sync after a base deletion re-reports the live
    // tail alongside the cancelled base. Reaping in phase 1 killed the routine phase 2 then re-created as
    // a duplicate twin — hence the exactly-one-active assertion.
    it('spares an anchor-less successor when the batch also carries a live _R master', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await seedSplitSeries(userId, 'master-batch1');

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [cancelledMaster('master-batch1'), liveMaster('master-batch1_R20260102T090000')],
            nextSyncToken: 'tok-batch1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const live = await expectSoleActiveRoutine(userId, 'master-batch1');
        expect(live._id).toBe('master-batch1-successor');
    });

    // Same-batch guard 2 (re-split): applying "this and all following" to a segment's FIRST occurrence
    // empties it, so GCal cancels that _R master and mints a new one. Reaping in phase 1 paused the
    // successor with an OPEN rrule, which no reactivation gate can undo — the series died with zero
    // active routines.
    it('spares a rebased successor being re-split within the same batch', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await seedSplitSeries(userId, 'master-batch2', { calendarRebasedEventId: 'master-batch2_R20260102T090000' });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [cancelledMaster('master-batch2_R20260102T090000'), liveMaster('master-batch2_R20260201T090000')],
            nextSyncToken: 'tok-batch2',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const live = await expectSoleActiveRoutine(userId, 'master-batch2');
        expect(live._id).toBe('master-batch2-successor');
    });

    // A sibling capped with a FUTURE UNTIL still produces occurrences for months — the series is alive.
    // Treating liveness as "open-ended only" reaped it, and unrecoverably: `newlyLosesUntil` waits for an
    // inbound OPEN rrule that a permanently-capped tail never sends.
    it('spares a successor when the batch carries a sibling capped in the future', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await seedSplitSeries(userId, 'master-capped');
        await itemsDAO.insertOne(makeItem(userId, { _id: 'item-capped-future', title: CANCELLED_MASTER_TITLE, routineId: 'master-capped-successor' }));

        const futureUntil = dayjs().add(60, 'day').format('YYYYMMDD[T235959Z]');
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [cancelledMaster('master-capped'), liveMaster('master-capped_R20260102T090000', `FREQ=WEEKLY;BYDAY=MO;UNTIL=${futureUntil}`)],
            nextSyncToken: 'tok-capped',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const live = await expectSoleActiveRoutine(userId, 'master-capped');
        expect(live._id).toBe('master-capped-successor');
        const item = await itemsDAO.findOne({ _id: 'item-capped-future' });
        expect(item!.status).toBe('calendar');
    });

    // `findActiveRoutineOnSeries` returns ANY active routine on the series — including a plain base with no
    // successor markers that phase 1's cancelled branch just declined to touch as our own echo. The reap
    // must honour that same window rather than silently overriding it on a pre-existing path.
    it('honours the own-echo window and leaves a just-pushed routine alone', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const now = dayjs().toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-echo',
                calendarEventId: 'master-echo',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                active: true,
                lastPushedToGCalTs: now,
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ ...cancelledMaster('master-echo'), updated: now }],
            nextSyncToken: 'tok-echo',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ _id: 'routine-echo' });
        expect(routine!.active).toBe(true);
        expect(routine!.rrule).not.toContain('UNTIL=');
    });
});

// ─── bareIdsWithLiveMasterInBatch — unit tests ────────────────────────────
//
// The reap's liveness predicate: which bare series ids still have a master producing occurrences. Getting
// this wrong in the "dead" direction retires a live series, so pin each case directly rather than only
// through the sync route.

describe('bareIdsWithLiveMasterInBatch', () => {
    const now = '2026-07-27T12:00:00.000Z';
    const master = (id: string, overrides: Partial<GCalEvent> = {}): GCalEvent => ({
        id,
        title: 'Standup',
        timeStart: '2026-07-28T09:00:00',
        timeEnd: '2026-07-28T09:30:00',
        updated: now,
        status: 'confirmed',
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
        ...overrides,
    });

    it('counts an open-ended master as live', () => {
        expect(bareIdsWithLiveMasterInBatch([master('evt-open')], now)).toEqual(new Set(['evt-open']));
    });

    it('counts a master capped in the future as live — it still produces occurrences', () => {
        const capped = master('evt-future', { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260925T235959Z'] });
        expect(bareIdsWithLiveMasterInBatch([capped], now)).toEqual(new Set(['evt-future']));
    });

    // A capped all-day series legally emits a date-only UNTIL; pins that it parses rather than falling through.
    it('counts a master capped with a date-only future UNTIL as live', () => {
        const capped = master('evt-dateonly', { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260925'] });
        expect(bareIdsWithLiveMasterInBatch([capped], now)).toEqual(new Set(['evt-dateonly']));
    });

    it('treats a master capped in the past as dead — the finished stump a split leaves behind', () => {
        const stump = master('evt-past', { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260606T205959Z'] });
        expect(bareIdsWithLiveMasterInBatch([stump], now)).toEqual(new Set());
    });

    it('treats a cancelled master as dead regardless of its rrule', () => {
        expect(bareIdsWithLiveMasterInBatch([master('evt-cancelled', { status: 'cancelled' })], now)).toEqual(new Set());
    });

    it('treats a master with no recurrence as dead — the series is no longer recurring', () => {
        const { recurrence: _omitted, ...single } = master('evt-single');
        expect(bareIdsWithLiveMasterInBatch([single], now)).toEqual(new Set());
    });

    it('normalizes _R rebased ids onto the bare series id', () => {
        expect(bareIdsWithLiveMasterInBatch([master('evt-bare_R20260102T090000')], now)).toEqual(new Set(['evt-bare']));
    });
});

// ── Notes / description sync ──────────────────────────────────────────────

describe('notes/description sync — inbound', () => {
    beforeEach(() => {
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
    });

    it('sets notes and lastSyncedNotes when importing a new GCal event with description', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const futureTs = dayjs().add(1, 'day').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-notes-1',
                    title: 'Lunch',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: futureTs,
                    status: 'confirmed',
                    description: 'Bring salad',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ calendarEventId: 'evt-notes-1' });
        expect(item?.notes).toBe('Bring salad');
        expect(item?.lastSyncedNotes).toBe('Bring salad');
    });

    it('updates notes when GCal description changed and GCal is newer', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-notes-upd',
            user: userId,
            status: 'calendar',
            title: 'Meeting',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-notes-2',
            calendarIntegrationId: 'int-1',
            notes: 'Old notes',
            lastSyncedNotes: 'Old notes',
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        const newerTs = dayjs().toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-notes-2',
                    title: 'Meeting',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: newerTs,
                    status: 'confirmed',
                    description: 'Updated from GCal',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-notes-upd' });
        expect(item?.notes).toBe('Updated from GCal');
        expect(item?.lastSyncedNotes).toBe('Updated from GCal');
    });

    it('preserves local notes when GCal description is unchanged (only title updated)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-notes-keep',
            user: userId,
            status: 'calendar',
            title: 'Old title',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-notes-3',
            calendarIntegrationId: 'int-1',
            notes: 'My local notes',
            lastSyncedNotes: 'Same as gcal',
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        const newerTs = dayjs().toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-notes-3',
                    title: 'New title',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: newerTs,
                    status: 'confirmed',
                    description: 'Same as gcal',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-notes-keep' });
        expect(item?.title).toBe('New title');
        expect(item?.notes).toBe('My local notes');
    });

    it('preserves local notes when GCal description changed but local is newer', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const newerTs = dayjs().toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-notes-local-wins',
            user: userId,
            status: 'calendar',
            title: 'Meeting',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-notes-4',
            calendarIntegrationId: 'int-1',
            notes: 'Locally edited notes',
            lastSyncedNotes: 'Original synced',
            createdTs: newerTs,
            updatedTs: newerTs,
        });

        const olderTs = dayjs().subtract(1, 'hour').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-notes-4',
                    title: 'Meeting',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: olderTs,
                    status: 'confirmed',
                    description: 'GCal description',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-notes-local-wins' });
        expect(item?.notes).toBe('Locally edited notes');
    });
});

describe('notes/description sync — outbound push-back', () => {
    it('passes description to updateEvent when pushing item with notes', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            calendarEventId: 'gcal-ev-notes',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            notes: 'Push these notes',
        });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(updateSpy).toHaveBeenCalledOnce();
        const updates = updateSpy.mock.calls[0]![2];
        // Markdown is converted to HTML for GCal; lastSyncedNotes stores the HTML sent.
        expect(updates).toHaveProperty('description', '<p>Push these notes</p>\n');

        const updated = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(updated!.lastSyncedNotes).toBe('<p>Push these notes</p>\n');
    });

    it('passes empty description when pushing item without notes', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            calendarEventId: 'gcal-ev-no-notes',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(updateSpy).toHaveBeenCalledOnce();
        const updates = updateSpy.mock.calls[0]![2];
        expect(updates).toHaveProperty('description', '');
    });

    it('sets lastSyncedNotes when creating a new GCal event with notes', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, { notes: 'New item notes' });
        await itemsDAO.insertOne(item);

        vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'new-gcal-notes-id' });

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        const updated = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(updated!.calendarEventId).toBe('new-gcal-notes-id');
        // lastSyncedNotes stores HTML (the value sent to GCal), not the raw Markdown.
        expect(updated!.lastSyncedNotes).toBe('<p>New item notes</p>\n');
    });
});

// ─── classifyRecurringMaster — unit tests ─────────────────────────────────

describe('classifyRecurringMaster', () => {
    const makeEvent = (over: Partial<GCalEvent> & Pick<GCalEvent, 'id'>): GCalEvent => ({
        title: 'Daily - Tech sync',
        timeStart: '2026-06-15T09:00:00Z',
        timeEnd: '2026-06-15T09:30:00Z',
        updated: '2026-06-01T00:00:00Z',
        status: 'confirmed',
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
        ...over,
    });
    const makeRoutine = (over: Partial<RoutineInterface> & Pick<RoutineInterface, 'calendarEventId'>): RoutineInterface => ({
        _id: 'r1',
        user: 'u1',
        title: 'Daily - Tech sync',
        routineType: 'calendar',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        active: true,
        createdTs: '2026-01-01T00:00:00Z',
        updatedTs: '2026-01-01T00:00:00Z',
        ...over,
    });
    const bareId = 'base-master';
    const successorId = `${bareId}_R20260615T090000`;

    it('flags an open _R event when a capped base sibling is in the batch', () => {
        const successor = makeEvent({ id: successorId, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] });
        const base = makeEvent({ id: bareId, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260101T000000Z'] });
        expect(classifyRecurringMaster(successor, [base, successor], [])).toBe('splitSuccessor');
    });

    it('flags an open _R event when an existing routine on the bare id is capped (no sibling in batch)', () => {
        const successor = makeEvent({ id: successorId });
        const capped = makeRoutine({ calendarEventId: bareId, rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260101T000000Z' });
        expect(classifyRecurringMaster(successor, [successor], [capped])).toBe('splitSuccessor');
    });

    it('flags an open _R event when an existing routine on the bare id is paused', () => {
        const successor = makeEvent({ id: successorId });
        const paused = makeRoutine({ calendarEventId: bareId, active: false });
        expect(classifyRecurringMaster(successor, [successor], [paused])).toBe('splitSuccessor');
    });

    it('flags an open _R event when a CAPPED EARLIER _R sibling (not the bare base) is in the batch — a re-split of an already-split series', () => {
        const earlierSuccessorId = `${bareId}_R20260501T090000`;
        const cappedEarlier = makeEvent({ id: earlierSuccessorId, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260614T000000Z'] });
        const successor = makeEvent({ id: successorId });
        expect(classifyRecurringMaster(successor, [cappedEarlier, successor], [])).toBe('splitSuccessor');
    });

    it('flags an open _R event when an ACTIVE, OPEN routine on the bare id is keyed to a different _R anchor (post-chain-re-anchor re-split)', () => {
        const successor = makeEvent({ id: successorId });
        const reanchored = makeRoutine({
            calendarEventId: bareId,
            active: true,
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            calendarRebasedEventId: `${bareId}_R20260501T090000`,
        });
        expect(classifyRecurringMaster(successor, [successor], [reanchored])).toBe('splitSuccessor');
    });

    it('treats an open _R event as a re-report when the active routine is keyed to THAT SAME _R anchor', () => {
        const successor = makeEvent({ id: successorId });
        const owner = makeRoutine({ calendarEventId: bareId, active: true, rrule: 'FREQ=WEEKLY;BYDAY=MO', calendarRebasedEventId: successorId });
        expect(classifyRecurringMaster(successor, [successor], [owner])).toBe('reReport');
    });

    it('treats a lone _R event with an active uncapped routine on the bare id as a re-report', () => {
        const successor = makeEvent({ id: successorId });
        const active = makeRoutine({ calendarEventId: bareId, active: true, rrule: 'FREQ=WEEKLY;BYDAY=MO' });
        expect(classifyRecurringMaster(successor, [successor], [active])).toBe('reReport');
    });

    it('treats a lone _R event with no related routine or sibling as a re-report', () => {
        const successor = makeEvent({ id: successorId });
        expect(classifyRecurringMaster(successor, [successor], [])).toBe('reReport');
    });

    it('does NOT flag a capped _R event (a historical segment, not the live tail)', () => {
        const cappedSuccessor = makeEvent({ id: successorId, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260601T000000Z'] });
        const capped = makeRoutine({ calendarEventId: bareId, active: false });
        expect(classifyRecurringMaster(cappedSuccessor, [cappedSuccessor], [capped])).toBe('reReport');
    });

    it('does NOT flag a bare (non-_R) master', () => {
        const base = makeEvent({ id: bareId });
        const capped = makeRoutine({ calendarEventId: bareId, active: false });
        expect(classifyRecurringMaster(base, [base], [capped])).toBe('reReport');
    });

    it('does NOT flag a cancelled _R event', () => {
        const cancelled = makeEvent({ id: successorId, status: 'cancelled', recurrence: [] });
        const capped = makeRoutine({ calendarEventId: bareId, active: false });
        expect(classifyRecurringMaster(cancelled, [cancelled], [capped])).toBe('reReport');
    });
});

// ─── pickSplitParent — unit tests ─────────────────────────────────────────

describe('pickSplitParent', () => {
    function makeCandidate(overrides: Partial<RoutineInterface>): RoutineInterface {
        const now = dayjs().toISOString();
        return {
            _id: 'cand-1',
            user: 'u',
            title: 'Standup',
            routineType: 'calendar',
            rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260504T205959Z',
            template: {},
            active: false,
            createdTs: now,
            updatedTs: now,
            calendarSyncConfigId: 'sync-config-1',
            calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            ...overrides,
        };
    }

    it('returns the matching candidate on the happy path', () => {
        const candidate = makeCandidate({});
        const parent = pickSplitParent({
            tail: { title: 'Standup', rrule: 'FREQ=WEEKLY;BYDAY=MO', calendarSyncConfigId: 'sync-config-1', tailStart: '2026-05-05T06:00:00Z' },
            candidates: [candidate],
        });
        expect(parent?._id).toBe('cand-1');
    });

    it('returns null when no candidates qualify', () => {
        const parent = pickSplitParent({
            tail: { title: 'Standup', rrule: 'FREQ=WEEKLY;BYDAY=MO', calendarSyncConfigId: 'sync-config-1', tailStart: '2026-05-05T06:00:00Z' },
            candidates: [],
        });
        expect(parent).toBeNull();
    });

    it('E8 regression: rejects when title differs even if gap is within window', () => {
        const candidate = makeCandidate({ title: 'Standup' });
        const parent = pickSplitParent({
            tail: { title: 'unrelated-E8-foo', rrule: 'FREQ=WEEKLY;BYDAY=WE', calendarSyncConfigId: 'sync-config-1', tailStart: '2026-05-06T11:00:00Z' },
            candidates: [candidate],
        });
        expect(parent).toBeNull();
    });

    it('E7 regression: picks the title-matching chain even when another chain has a closer gap', () => {
        // Wrong chain — closer gap but different title.
        const wrong = makeCandidate({ _id: 'wrong', title: 'unrelated chain', rrule: 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20260505T055959Z' });
        // Right chain — same title; UNTIL placed just before the tail start (the typical GCal pattern).
        const right = makeCandidate({ _id: 'right', title: 'E7 original', rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260505T055959Z' });
        const parent = pickSplitParent({
            tail: { title: 'E7 original', rrule: 'FREQ=WEEKLY;BYDAY=TU,TH', calendarSyncConfigId: 'sync-config-1', tailStart: '2026-05-05T06:00:00Z' },
            candidates: [wrong, right],
        });
        expect(parent?._id).toBe('right');
    });

    it('rejects when gap exceeds 1 day', () => {
        const candidate = makeCandidate({ rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260501T205959Z' });
        const parent = pickSplitParent({
            tail: { title: 'Standup', rrule: 'FREQ=WEEKLY;BYDAY=MO', calendarSyncConfigId: 'sync-config-1', tailStart: '2026-05-05T06:00:00Z' },
            candidates: [candidate],
        });
        expect(parent).toBeNull();
    });

    it('rejects when tail start precedes UNTIL (negative gap)', () => {
        const candidate = makeCandidate({ rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260510T205959Z' });
        const parent = pickSplitParent({
            tail: { title: 'Standup', rrule: 'FREQ=WEEKLY;BYDAY=MO', calendarSyncConfigId: 'sync-config-1', tailStart: '2026-05-05T06:00:00Z' },
            candidates: [candidate],
        });
        expect(parent).toBeNull();
    });

    it('rejects when calendarSyncConfigId differs', () => {
        const candidate = makeCandidate({ calendarSyncConfigId: 'sync-config-other' });
        const parent = pickSplitParent({
            tail: { title: 'Standup', rrule: 'FREQ=WEEKLY;BYDAY=MO', calendarSyncConfigId: 'sync-config-1', tailStart: '2026-05-05T06:00:00Z' },
            candidates: [candidate],
        });
        expect(parent).toBeNull();
    });

    it('accepts disjoint BYDAY (real splits usually change weekday, e.g. MO → TU)', () => {
        const candidate = makeCandidate({ rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260504T205959Z' });
        const parent = pickSplitParent({
            tail: { title: 'Standup', rrule: 'FREQ=WEEKLY;BYDAY=TU', calendarSyncConfigId: 'sync-config-1', tailStart: '2026-05-05T06:00:00Z' },
            candidates: [candidate],
        });
        expect(parent?._id).toBe('cand-1');
    });

    it('picks the smallest-gap candidate among multiple passing', () => {
        const farther = makeCandidate({ _id: 'far', rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260504T000000Z' });
        const closer = makeCandidate({ _id: 'close', rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260504T205959Z' });
        const parent = pickSplitParent({
            tail: { title: 'Standup', rrule: 'FREQ=WEEKLY;BYDAY=MO', calendarSyncConfigId: 'sync-config-1', tailStart: '2026-05-05T06:00:00Z' },
            candidates: [farther, closer],
        });
        expect(parent?._id).toBe('close');
    });

    it('tie-breaks on _id when gaps are equal', () => {
        const a = makeCandidate({ _id: 'aaa', rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260504T205959Z' });
        const b = makeCandidate({ _id: 'bbb', rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260504T205959Z' });
        const parent = pickSplitParent({
            tail: { title: 'Standup', rrule: 'FREQ=WEEKLY;BYDAY=MO', calendarSyncConfigId: 'sync-config-1', tailStart: '2026-05-05T06:00:00Z' },
            candidates: [b, a],
        });
        expect(parent?._id).toBe('aaa');
    });

    it('normalizes whitespace and case when comparing titles', () => {
        const candidate = makeCandidate({ title: 'Standup' });
        const parent = pickSplitParent({
            tail: { title: '  standup ', rrule: 'FREQ=WEEKLY;BYDAY=MO', calendarSyncConfigId: 'sync-config-1', tailStart: '2026-05-05T06:00:00Z' },
            candidates: [candidate],
        });
        expect(parent?._id).toBe('cand-1');
    });
});
