/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import dayjs from 'dayjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { maybePushToGCal } from '../lib/calendarPushback.js';
import type { ItemInterface, OperationInterface, RoutineInterface } from '../types/entities.js';
import {
    app,
    getUserId,
    insertIntegrationWithConfig,
    loginAsAlice,
    makeIntegration,
    makeOp,
    makeRoutine,
    mockBuildProvider,
    useCalendarTestLifecycle,
} from './calendarTestKit.js';
import { authenticatedRequest } from './helpers.js';

useCalendarTestLifecycle();

// ─── POST /calendar/integrations/:id/sync — split detection ──────────────

describe('POST /calendar/integrations/:id/sync — split detection', () => {
    beforeEach(() => {
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
    });

    // ─── `_R<…>` rebased-master split successor onboarding ──────────────────────────────────────
    // Regression for "recurring events invisible after a GCal 'this and all following' split": Google
    // caps the base master `<id>` (past UNTIL) and creates an open-ended successor `<id>_R<anchor>`.
    // Both arrive in one batch and both normalize to `<id>`; pre-fix the successor was collapsed onto
    // the capped base routine and never onboarded → the live series showed nothing in the app.

    it('onboards an open-ended _R successor as a new active routine when the capped base arrives in the same batch', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = '3qp933p629fvlgob08faqdtaak';
        const successorId = `${bareId}_R20260615T090000`;
        // Pre-seed the original active series on the bare id (the routine the user already has).
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Daily - Tech sync',
                rrule: 'FREQ=WEEKLY;WKST=SU;BYDAY=MO,TU,WE',
                active: true,
                updatedTs: dayjs().subtract(2, 'hour').toISOString(),
            }),
        );

        const tz = 'Asia/Jerusalem';
        const successorStart = dayjs().tz(tz).add(1, 'day').hour(11).minute(0).second(0).millisecond(0).toISOString();
        const successorEnd = dayjs(successorStart).add(30, 'minute').toISOString();
        // Base caps the day before the successor's first occurrence.
        const untilCompact = dayjs(successorStart).subtract(1, 'second').utc().format('YYYYMMDD[T]HHmmss[Z]');

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: bareId,
                    title: 'Daily - Tech sync',
                    timeStart: dayjs().subtract(30, 'day').toISOString(),
                    timeEnd: dayjs().subtract(30, 'day').add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: [`RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=MO,TU,WE;UNTIL=${untilCompact}`],
                },
                {
                    id: successorId,
                    title: 'Daily - Tech sync',
                    timeStart: successorStart,
                    timeEnd: successorEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=MO,TU,WE'],
                },
            ],
            nextSyncToken: 'tok-split',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const onSeries = await routinesDAO.findArray({ user: userId, calendarEventId: bareId, calendarIntegrationId: 'int-1' });
        // Two routines now share the bare id: the capped (paused) parent + the open active successor.
        const active = onSeries.filter((r) => r.active);
        expect(active).toHaveLength(1);
        const [successor] = active;
        if (!successor) throw new Error('expected one active routine on the series');
        expect(successor.rrule).not.toContain('UNTIL=');
        expect(successor.calendarEventId).toBe(bareId);
        expect(successor._id).not.toBe('routine-base');
        expect(successor.splitFromRoutineId).toBe('routine-base');
        // The capped parent is paused with its UNTIL retained (GCal truth — not stripped).
        const parent = await routinesDAO.findByOwnerAndId('routine-base', userId);
        expect(parent!.active).toBe(false);
        expect(parent!.rrule).toContain('UNTIL=');

        // Successor materialised future items, all keyed on the BARE id (so they match GCal instance
        // ids — the duplicate-items regression guard) and at the new 11:00 wall-clock time.
        const items = await itemsDAO.findArray({ user: userId, routineId: successor._id, status: 'calendar' });
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            expect(item.timeStart).toMatch(/T11:00:00$/);
            expect(item.calendarInstanceEventId?.startsWith(`${bareId}_`)).toBe(true);
            expect(item.calendarInstanceEventId).not.toContain('_R');
        }
    });

    it('onboards an _R successor when only it arrives but the base routine is already capped (webhook-only batch)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = '42lpclon5cuqh5pggln2u5adlk';
        const successorId = `${bareId}_R20260620T073000`;
        // Base already capped + paused on a prior sync; only the successor arrives now.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base-capped',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Daily - Team Leaders',
                rrule: 'FREQ=WEEKLY;WKST=SU;BYDAY=TH,SU,MO;UNTIL=20260101T205959Z',
                active: false,
                updatedTs: dayjs().subtract(1, 'day').toISOString(),
            }),
        );

        const tz = 'Asia/Jerusalem';
        const successorStart = dayjs().tz(tz).add(1, 'day').hour(10).minute(30).second(0).millisecond(0).toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: successorId,
                    title: 'Daily - Team Leaders',
                    timeStart: successorStart,
                    timeEnd: dayjs(successorStart).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=TH,SU,MO'],
                },
            ],
            nextSyncToken: 'tok-webhook',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const active = (await routinesDAO.findArray({ user: userId, calendarEventId: bareId, calendarIntegrationId: 'int-1' })).filter((r) => r.active);
        expect(active).toHaveLength(1);
        const [successor] = active;
        if (!successor) throw new Error('expected one active successor');
        expect(successor.rrule).not.toContain('UNTIL=');
        expect(successor.splitFromRoutineId).toBe('routine-base-capped');
        // Parent untouched, still capped + paused.
        const parent = await routinesDAO.findByOwnerAndId('routine-base-capped', userId);
        expect(parent!.active).toBe(false);
    });

    it('is idempotent: re-running the split sync creates no second successor and no duplicate items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'mleem99efhim4a0tsh3s86797o';
        const successorId = `${bareId}_R20260618T090000`;
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base-idem',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Standup',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                active: true,
                updatedTs: dayjs().subtract(2, 'hour').toISOString(),
            }),
        );

        const tz = 'Asia/Jerusalem';
        const successorStart = dayjs().tz(tz).add(1, 'day').hour(9).minute(0).second(0).millisecond(0).toISOString();
        const untilCompact = dayjs(successorStart).subtract(1, 'second').utc().format('YYYYMMDD[T]HHmmss[Z]');
        const events = [
            {
                id: bareId,
                title: 'Standup',
                timeStart: dayjs().subtract(30, 'day').toISOString(),
                timeEnd: dayjs().subtract(30, 'day').add(30, 'minute').toISOString(),
                updated: dayjs().toISOString(),
                status: 'confirmed' as const,
                recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=${untilCompact}`],
            },
            {
                id: successorId,
                title: 'Standup',
                timeStart: successorStart,
                timeEnd: dayjs(successorStart).add(30, 'minute').toISOString(),
                updated: dayjs().toISOString(),
                status: 'confirmed' as const,
                recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
            },
        ];
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events, nextSyncToken: 'tok-idem' });

        await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        const afterFirst = await routinesDAO.findArray({ user: userId, calendarEventId: bareId, calendarIntegrationId: 'int-1' });
        const [activeFirst] = afterFirst.filter((r) => r.active);
        if (!activeFirst) throw new Error('expected an active successor after first sync');
        const itemsFirst = await itemsDAO.findArray({ user: userId, routineId: activeFirst._id, status: 'calendar' });

        // Second sync with the identical batch — must not duplicate the successor or its items.
        await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        const afterSecond = await routinesDAO.findArray({ user: userId, calendarEventId: bareId, calendarIntegrationId: 'int-1' });
        expect(afterSecond).toHaveLength(afterFirst.length);
        expect(afterSecond.filter((r) => r.active)).toHaveLength(1);
        const itemsSecond = await itemsDAO.findArray({ user: userId, routineId: activeFirst._id, status: 'calendar' });
        expect(itemsSecond.length).toBe(itemsFirst.length);
    });

    it('re-report guard: a lone _R event with an active uncapped routine on the bare id does NOT create a successor', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'rereport-master-id';
        const successorId = `${bareId}_R20260519T123000`;
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-rereport',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Standup',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                active: true,
                updatedTs: dayjs().subtract(2, 'hour').toISOString(),
            }),
        );

        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. Under TZ=UTC (CI), the old
        // `dayjs().hour(9)` produced 09:00 UTC = 12:00 Jerusalem, so the inferred schedule differed from
        // the stored template → the sync regenerated (churned) items instead of converging. See line ~8817.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: successorId,
                    title: 'Standup',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-rereport',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const onSeries = await routinesDAO.findArray({ user: userId, calendarEventId: bareId, calendarIntegrationId: 'int-1' });
        // Exactly the one pre-existing routine — the lone _R event was treated as a re-report.
        expect(onSeries).toHaveLength(1);
        const [routine] = onSeries;
        if (!routine) throw new Error('expected one routine');
        expect(routine._id).toBe('routine-rereport');
        expect(routine.splitFromRoutineId).toBeUndefined();
        expect(routine.active).toBe(true);
    });

    it('links a new master to its split parent and pauses the parent (happy path)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'parent-routine',
                calendarEventId: 'master-parent',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Weekly sync',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                updatedTs: oldTs,
            }),
        );

        const parentStart = dayjs().add(1, 'day').toISOString();
        const parentEnd = dayjs().add(1, 'day').add(30, 'minute').toISOString();
        const tailStart = dayjs().add(8, 'day').hour(9).minute(0).second(0).millisecond(0).toISOString();
        const tailEnd = dayjs(tailStart).add(30, 'minute').toISOString();
        const untilCompact = dayjs(tailStart).subtract(1, 'second').utc().format('YYYYMMDD[T]HHmmss[Z]');

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-parent',
                    title: 'Weekly sync',
                    timeStart: parentStart,
                    timeEnd: parentEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=${untilCompact}`],
                },
                {
                    id: 'master-tail',
                    title: 'Weekly sync',
                    timeStart: tailStart,
                    timeEnd: tailEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const tail = await routinesDAO.findOne({ calendarEventId: 'master-tail' });
        expect(tail).not.toBeNull();
        expect(tail!.splitFromRoutineId).toBe('parent-routine');

        const parent = await routinesDAO.findByOwnerAndId('parent-routine', userId);
        expect(parent!.active).toBe(false);
        expect(parent!.rrule).toContain('UNTIL=');
    });

    // Regression for the GCal "this and following + time shift" bug: the tail routine arrived
    // via sync but its calendar items were never generated, because createRoutineFromGCal only
    // stored the routine. Symptom: parent's future items got trashed past UNTIL (correct), tail
    // had zero items, so the user saw "two routines, same name, items missing for the tail".
    it('generates calendar items for the new tail routine when GCal splits with a time shift', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'parent-shift',
                calendarEventId: 'master-parent-shift',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Daily standup',
                rrule: 'FREQ=DAILY',
                calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
                updatedTs: oldTs,
            }),
        );

        // Parent retains its original 09:00 timing; tail picks up the same series at 11:00 the next day.
        // Construct in Asia/Jerusalem (the sync config's timezone) so extractLocalTime round-trips
        // to the expected HH:mm regardless of the test runner's local timezone (CI runs in UTC).
        const tz = 'Asia/Jerusalem';
        const parentStart = dayjs().tz(tz).add(1, 'day').hour(9).minute(0).second(0).millisecond(0).toISOString();
        const parentEnd = dayjs(parentStart).add(30, 'minute').toISOString();
        const tailStart = dayjs().tz(tz).add(2, 'day').hour(11).minute(0).second(0).millisecond(0).toISOString();
        const tailEnd = dayjs(tailStart).add(30, 'minute').toISOString();
        const untilCompact = dayjs(tailStart).subtract(1, 'second').utc().format('YYYYMMDD[T]HHmmss[Z]');

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-parent-shift',
                    title: 'Daily standup',
                    timeStart: parentStart,
                    timeEnd: parentEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: [`RRULE:FREQ=DAILY;UNTIL=${untilCompact}`],
                },
                {
                    id: 'master-tail-shift',
                    title: 'Daily standup',
                    timeStart: tailStart,
                    timeEnd: tailEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=DAILY'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const tail = await routinesDAO.findOne({ calendarEventId: 'master-tail-shift' });
        expect(tail).not.toBeNull();
        expect(tail!.splitFromRoutineId).toBe('parent-shift');
        expect(tail!.calendarItemTemplate?.timeOfDay).toBe('11:00');

        // The tail must have its future calendar items materialised — otherwise the user sees a
        // routine with no items after the split. All items must use the new 11:00 timeOfDay.
        // item.timeStart is stored as a naive "YYYY-MM-DDTHH:mm:ss" string built directly from the
        // routine's timeOfDay (no offset), so a substring match is the timezone-independent check.
        const tailItems = await itemsDAO.findArray({ user: userId, routineId: tail!._id, status: 'calendar' });
        expect(tailItems.length).toBeGreaterThan(0);
        for (const item of tailItems) {
            expect(item.timeStart).toBeDefined();
            expect(item.timeStart).toMatch(/T11:00:00$/);
        }
    });

    // Regression for the "daily series invisible after split" bug: when GCal splits with an `_R<…>`
    // successor on the SAME bare master, the parent gets a past UNTIL and its overlapping future items
    // are trashed — but those trashed items used to keep their `calendarInstanceEventId`, which still
    // occupied the presence-partial unique index. The successor (sharing the bare master id) then
    // produced the SAME instance ids, so its inserts E11000'd and were silently swallowed → zero items.
    // The cap path must now FREE the instance id so the successor materialises every occurrence.
    it('successor on the same bare master regenerates items the capped parent trashed (instance id freed)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'shared-daily-master';
        const tz = 'Asia/Jerusalem';
        // Parent already active with overlapping future items at 10:00 daily.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'parent-daily',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Daily standup',
                rrule: 'FREQ=DAILY',
                calendarItemTemplate: { timeOfDay: '10:00', duration: 30 },
                updatedTs: dayjs().subtract(2, 'hour').toISOString(),
            }),
        );
        // Seed a future parent item that collides with the successor's first occurrences.
        const collidingDate = dayjs().tz(tz).add(2, 'day').format('YYYY-MM-DD');
        const collidingInstanceId = `${bareId}_${dayjs.tz(`${collidingDate}T10:00:00`, tz).utc().format('YYYYMMDD[T]HHmmss[Z]')}`;
        await itemsDAO.insertOne({
            _id: 'parent-future-item',
            user: userId,
            status: 'calendar',
            title: 'Daily standup',
            timeStart: `${collidingDate}T10:00:00`,
            timeEnd: `${collidingDate}T10:30:00`,
            routineId: 'parent-daily',
            calendarEventId: bareId,
            calendarInstanceEventId: collidingInstanceId,
            calendarIntegrationId: 'int-1',
            createdTs: dayjs().subtract(2, 'hour').toISOString(),
            updatedTs: dayjs().subtract(2, 'hour').toISOString(),
        });

        // Sync batch: capped base (past UNTIL) + open successor `<bareId>_R<anchor>`, same 10:00 daily.
        const successorStart = dayjs().tz(tz).add(1, 'day').hour(10).minute(0).second(0).millisecond(0).toISOString();
        const untilCompact = dayjs(successorStart).subtract(1, 'second').utc().format('YYYYMMDD[T]HHmmss[Z]');
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: bareId,
                    title: 'Daily standup',
                    timeStart: dayjs().subtract(30, 'day').toISOString(),
                    timeEnd: dayjs().subtract(30, 'day').add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: [`RRULE:FREQ=DAILY;UNTIL=${untilCompact}`],
                },
                {
                    id: `${bareId}_R20260615T070000`,
                    title: 'Daily standup',
                    timeStart: successorStart,
                    timeEnd: dayjs(successorStart).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=DAILY'],
                },
            ],
            nextSyncToken: 'tok-instance-free',
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // The parent's colliding item was trashed AND its instance id freed.
        const trashedParentItem = await itemsDAO.findByOwnerAndId('parent-future-item', userId);
        expect(trashedParentItem!.status).toBe('trash');
        expect(trashedParentItem!.calendarInstanceEventId).toBeUndefined();

        // The active successor materialised items — including the previously-colliding date — none swallowed.
        const [successor] = (await routinesDAO.findArray({ user: userId, calendarEventId: bareId, calendarIntegrationId: 'int-1' })).filter((r) => r.active);
        if (!successor) throw new Error('expected an active successor');
        const successorItems = await itemsDAO.findArray({ user: userId, routineId: successor._id, status: 'calendar' });
        expect(successorItems.length).toBeGreaterThan(0);
        expect(successorItems.some((i) => i.calendarInstanceEventId === collidingInstanceId)).toBe(true);
    });

    it('E8 regression: does not link an unrelated master whose start happens to fall within the gap window', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Pre-seed a capped parent routine (already paused by a prior sync).
        const untilIso = dayjs().add(7, 'day').toISOString();
        const untilCompact = dayjs(untilIso).utc().format('YYYYMMDD[T]HHmmss[Z]');
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'capped-unrelated',
                calendarEventId: 'master-capped',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Weekly sync',
                rrule: `FREQ=WEEKLY;BYDAY=MO;UNTIL=${untilCompact}`,
                active: false,
                updatedTs: dayjs().toISOString(),
            }),
        );

        // New, unrelated master: different title, different BYDAY, but start falls inside the 0–1 day window after UNTIL.
        const unrelatedStart = dayjs(untilIso).add(1, 'hour').toISOString();
        const unrelatedEnd = dayjs(unrelatedStart).add(1, 'hour').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-unrelated',
                    title: 'Unrelated event',
                    timeStart: unrelatedStart,
                    timeEnd: unrelatedEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const unrelated = await routinesDAO.findOne({ calendarEventId: 'master-unrelated' });
        expect(unrelated).not.toBeNull();
        expect(unrelated!.splitFromRoutineId).toBeUndefined();
    });

    it('flips active to false when GCal newly adds UNTIL to an existing routine', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-gets-capped',
                calendarEventId: 'master-gets-capped',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Weekly sync',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                active: true,
                updatedTs: oldTs,
            }),
        );

        // Future calendar item that should be trashed by the UNTIL cap.
        const futureItemStart = dayjs().add(30, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'future-item',
            user: userId,
            status: 'calendar',
            title: 'Weekly sync',
            timeStart: futureItemStart,
            timeEnd: dayjs(futureItemStart).add(30, 'minute').toISOString(),
            routineId: 'routine-gets-capped',
            calendarEventId: 'master-gets-capped',
            calendarIntegrationId: 'int-1',
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        const untilIso = dayjs().add(7, 'day').toISOString();
        const untilCompact = dayjs(untilIso).utc().format('YYYYMMDD[T]HHmmss[Z]');
        const eventStart = dayjs().add(1, 'day').toISOString();
        const eventEnd = dayjs(eventStart).add(30, 'minute').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-gets-capped',
                    title: 'Weekly sync',
                    timeStart: eventStart,
                    timeEnd: eventEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=${untilCompact}`],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findByOwnerAndId('routine-gets-capped', userId);
        expect(routine!.active).toBe(false);
        expect(routine!.rrule).toContain('UNTIL=');

        // Future item past UNTIL should be trashed.
        const item = await itemsDAO.findByOwnerAndId('future-item', userId);
        expect(item!.status).toBe('trash');

        // The update operation snapshot should carry active: false so other devices sync it.
        const ops = await operationsDAO.findArray({ entityId: 'routine-gets-capped', entityType: 'routine' });
        const routineUpdateOp = ops.find((op: OperationInterface) => op.opType === 'update');
        expect(routineUpdateOp).toBeDefined();
        expect((routineUpdateOp!.snapshot as RoutineInterface).active).toBe(false);
    });

    it('does not re-flip active on repeat sync of an already-capped, already-inactive parent', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const untilIso = dayjs().add(7, 'day').toISOString();
        const untilCompact = dayjs(untilIso).utc().format('YYYYMMDD[T]HHmmss[Z]');
        const oldTs = dayjs().subtract(2, 'hour').toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'already-capped',
                calendarEventId: 'master-already-capped',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                title: 'Weekly sync',
                rrule: `FREQ=WEEKLY;BYDAY=MO;UNTIL=${untilCompact}`,
                active: false,
                updatedTs: oldTs,
            }),
        );

        const eventStart = dayjs().add(1, 'day').toISOString();
        const eventEnd = dayjs(eventStart).add(30, 'minute').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-already-capped',
                    title: 'Weekly sync',
                    timeStart: eventStart,
                    timeEnd: eventEnd,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=${untilCompact}`],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findByOwnerAndId('already-capped', userId);
        expect(routine!.active).toBe(false);
    });

    it('does not treat a freshly-imported tail as a parent for another freshly-imported tail in the same cycle', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // No pre-existing routine: both events are new this cycle. One carries UNTIL (resembles a
        // capped series) and the other's start falls within the 0–1 day gap — but since neither
        // existed before the import, detectAndLinkSplits must leave both unlinked.
        const tailA_Start = dayjs().add(10, 'day').hour(9).minute(0).second(0).millisecond(0).toISOString();
        const tailA_End = dayjs(tailA_Start).add(30, 'minute').toISOString();
        const untilCompact = dayjs(tailA_Start).subtract(1, 'second').utc().format('YYYYMMDD[T]HHmmss[Z]');
        const tailB_Start = dayjs(tailA_Start).add(1, 'hour').toISOString();
        const tailB_End = dayjs(tailB_Start).add(30, 'minute').toISOString();

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-new-capped',
                    title: 'Weekly sync',
                    timeStart: dayjs().add(1, 'day').toISOString(),
                    timeEnd: dayjs().add(1, 'day').add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=${untilCompact}`],
                },
                {
                    id: 'master-new-tailA',
                    title: 'Weekly sync',
                    timeStart: tailA_Start,
                    timeEnd: tailA_End,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'],
                },
                {
                    id: 'master-new-tailB',
                    title: 'Weekly sync',
                    timeStart: tailB_Start,
                    timeEnd: tailB_End,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const tailA = await routinesDAO.findOne({ calendarEventId: 'master-new-tailA' });
        const tailB = await routinesDAO.findOne({ calendarEventId: 'master-new-tailB' });
        expect(tailA!.splitFromRoutineId).toBeUndefined();
        expect(tailB!.splitFromRoutineId).toBeUndefined();
    });
});

// ─── Routine startDate ──────────────────────────────────────────────────────

describe('routine startDate', () => {
    it('seriesStartDate uses startDate when set, else createdTs', async () => {
        // Late import to avoid circular load ordering with rrule bundle.
        const { seriesStartDate } = await import('../calendarProviders/GoogleCalendarProvider.js');
        const base = makeRoutine('u-any', { createdTs: '2026-01-01T00:00:00.000Z', rrule: 'FREQ=DAILY' });
        expect(seriesStartDate(base)).toBe('2026-01-01');
        const withStartDate = { ...base, startDate: '2026-06-15' };
        expect(seriesStartDate(withStartDate)).toBe('2026-06-15');
    });

    it('seriesStartDate with startDate > UNTIL throws', async () => {
        const { seriesStartDate } = await import('../calendarProviders/GoogleCalendarProvider.js');
        const routine = makeRoutine('u-any', {
            createdTs: '2026-01-01T00:00:00.000Z',
            startDate: '2026-12-01',
            rrule: 'FREQ=DAILY;UNTIL=20260401T235959Z',
        });
        expect(() => seriesStartDate(routine)).toThrow(/no occurrences/);
    });

    it('createRecurringEvent anchors GCal DTSTART on startDate (not createdTs)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routine = makeRoutine(userId, {
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            createdTs: '2026-01-01T00:00:00.000Z',
            startDate: '2026-06-15',
            rrule: 'FREQ=DAILY',
        });
        await routinesDAO.insertOne(routine);

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('gcal-new-id');

        await maybePushToGCal(makeOp(userId, { entityType: 'routine', entityId: routine._id, snapshot: routine }), mockBuildProvider());

        // createRecurringEvent itself computes seriesStartDate internally — we assert it was called
        // with the routine that has startDate set. Trailing options arg (deterministic id) ignored here.
        expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ startDate: '2026-06-15' }), 'primary', 'Asia/Jerusalem', expect.anything());
    });
});

// ─── Routine pause ───────────────────────────────────────────────────────────

describe('routine pause', () => {
    it('pause pushback caps the GCal master with UNTIL=<yesterday> and leaves eventId stable', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routineActive = makeRoutine(userId, {
            calendarEventId: 'gcal-master-pause',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            active: true,
            updatedTs: '2026-01-01T10:00:00.000Z',
        });
        await routinesDAO.insertOne(routineActive);
        // Seed a prior operation so handleRoutinePush detects the active transition.
        await operationsDAO.insertOne({
            _id: 'op-prior',
            user: userId,
            deviceId: 'device-1',
            ts: '2026-01-01T09:59:00.000Z',
            entityType: 'routine',
            entityId: routineActive._id,
            opType: 'create',
            snapshot: routineActive,
        });

        const capSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'capRecurringEvent').mockResolvedValue(undefined);
        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringEvent').mockResolvedValue(undefined);

        const pausedSnapshot: RoutineInterface = { ...routineActive, active: false, updatedTs: '2026-01-01T11:00:00.000Z' };
        await routinesDAO.replaceById(routineActive._id, pausedSnapshot);
        await maybePushToGCal(
            makeOp(userId, { entityType: 'routine', entityId: pausedSnapshot._id, snapshot: pausedSnapshot, ts: '2026-01-01T11:00:00.000Z' }),
            mockBuildProvider(),
        );

        expect(capSpy).toHaveBeenCalledOnce();
        expect(capSpy).toHaveBeenCalledWith('gcal-master-pause', expect.stringMatching(/^\d{8}T235959Z$/), 'primary', 'Asia/Jerusalem');
        // steady-state updateRecurringEvent must NOT fire alongside the cap.
        expect(updateSpy).not.toHaveBeenCalled();
    });

    it('pause pushback trashes future items and leaves past/done items alone', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routine = makeRoutine(userId, {
            _id: 'routine-pause-items',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            active: true,
            updatedTs: '2026-01-02T10:00:00.000Z',
        });
        await routinesDAO.insertOne(routine);
        // Seed prior op with active=true.
        await operationsDAO.insertOne({
            _id: 'op-prior-2',
            user: userId,
            deviceId: 'device-1',
            ts: '2026-01-02T09:59:00.000Z',
            entityType: 'routine',
            entityId: routine._id,
            opType: 'create',
            snapshot: routine,
        });

        const todayStr = dayjs().startOf('day').format('YYYY-MM-DD');
        const yesterdayStr = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
        const tomorrowStr = dayjs().add(1, 'day').format('YYYY-MM-DD');
        await itemsDAO.insertMany([
            {
                _id: 'past-done',
                user: userId,
                status: 'done',
                title: 'past-done',
                routineId: routine._id,
                timeStart: `${yesterdayStr}T09:00:00`,
                createdTs: yesterdayStr,
                updatedTs: yesterdayStr,
            },
            {
                _id: 'future-calendar',
                user: userId,
                status: 'calendar',
                title: 'future',
                routineId: routine._id,
                timeStart: `${tomorrowStr}T09:00:00`,
                createdTs: todayStr,
                updatedTs: todayStr,
            },
        ]);

        vi.spyOn(GoogleCalendarProvider.prototype, 'capRecurringEvent').mockResolvedValue(undefined);

        const pausedSnapshot: RoutineInterface = { ...routine, active: false, updatedTs: '2026-01-02T11:00:00.000Z' };
        await routinesDAO.replaceById(routine._id, pausedSnapshot);
        await maybePushToGCal(
            makeOp(userId, { entityType: 'routine', entityId: pausedSnapshot._id, snapshot: pausedSnapshot, ts: '2026-01-02T11:00:00.000Z' }),
            mockBuildProvider(),
        );

        const future = await itemsDAO.findByOwnerAndId('future-calendar', userId);
        const past = await itemsDAO.findByOwnerAndId('past-done', userId);
        expect(future!.status).toBe('trash');
        expect(past!.status).toBe('done'); // untouched
    });

    it('capRecurringEvent strips existing UNTIL/COUNT and appends the new UNTIL (unit-level)', async () => {
        const { rrulePinnedUntil } = await import('../calendarProviders/GoogleCalendarProvider.js');
        // Pre-existing LATER UNTIL — pulled back (capping earlier is always allowed).
        expect(rrulePinnedUntil('RRULE:FREQ=DAILY;UNTIL=20260601T235959Z', '20260423T235959Z')).toBe('RRULE:FREQ=DAILY;UNTIL=20260423T235959Z');
        // Pre-existing COUNT — stripped (UNTIL and COUNT are mutually exclusive).
        expect(rrulePinnedUntil('RRULE:FREQ=WEEKLY;COUNT=5;BYDAY=MO', '20260423T235959Z')).toBe('RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260423T235959Z');
        // No prior cap.
        expect(rrulePinnedUntil('RRULE:FREQ=DAILY', '20260423T235959Z')).toBe('RRULE:FREQ=DAILY;UNTIL=20260423T235959Z');
    });

    it('capRecurringEvent never moves an existing UNTIL forward — that would resurrect dead occurrences (unit-level)', async () => {
        const { rrulePinnedUntil } = await import('../calendarProviders/GoogleCalendarProvider.js');
        // Pausing a routine whose GCal master a split already capped months ago: the earlier cap wins.
        expect(rrulePinnedUntil('RRULE:FREQ=DAILY;UNTIL=20260301T235959Z', '20260423T235959Z')).toBe('RRULE:FREQ=DAILY;UNTIL=20260301T235959Z');
        // Equal cutoff — unchanged.
        expect(rrulePinnedUntil('RRULE:FREQ=DAILY;UNTIL=20260423T235959Z', '20260423T235959Z')).toBe('RRULE:FREQ=DAILY;UNTIL=20260423T235959Z');
        // Bare-date existing UNTIL (all-day series) compares correctly against a datetime request.
        expect(rrulePinnedUntil('RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260301', '20260423T235959Z')).toBe('RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260301');
        // Prefix-less body form is preserved on the keep path too.
        expect(rrulePinnedUntil('FREQ=DAILY;UNTIL=20260301T235959Z', '20260423T235959Z')).toBe('RRULE:FREQ=DAILY;UNTIL=20260301T235959Z');
    });

    it('resume pushback: fires updateRecurringEvent (clears UNTIL) and regenerates future items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Routine currently paused (active=false). Prior op is the pause; the NEW op flips active=true.
        const pausedRoutine = makeRoutine(userId, {
            _id: 'routine-resume',
            calendarEventId: 'gcal-master-resume',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            active: false,
            updatedTs: '2026-01-05T09:00:00.000Z',
        });
        await routinesDAO.insertOne(pausedRoutine);
        await operationsDAO.insertOne({
            _id: 'op-paused-prior',
            user: userId,
            deviceId: 'device-1',
            ts: '2026-01-05T09:00:00.000Z',
            entityType: 'routine',
            entityId: pausedRoutine._id,
            opType: 'update',
            snapshot: pausedRoutine,
        });

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringEvent').mockResolvedValue(undefined);
        const capSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'capRecurringEvent').mockResolvedValue(undefined);

        const resumedSnapshot: RoutineInterface = { ...pausedRoutine, active: true, updatedTs: '2026-01-05T11:00:00.000Z' };
        await routinesDAO.replaceById(pausedRoutine._id, resumedSnapshot);
        await maybePushToGCal(
            makeOp(userId, {
                _id: 'op-resume-current',
                entityType: 'routine',
                entityId: resumedSnapshot._id,
                snapshot: resumedSnapshot,
                ts: '2026-01-05T11:00:00.000Z',
            }),
            mockBuildProvider(),
        );

        expect(updateSpy).toHaveBeenCalledOnce();
        expect(capSpy).not.toHaveBeenCalled();
    });

    it('two back-to-back pause ops: cap fires exactly once (second op sees first as prior)', async () => {
        // I7 regression: when two pause ops land in quick succession for the same routine (e.g. from
        // two flush batches), the pre-fix `readPriorActiveFlag` excluded only the current op by _id.
        // That made BOTH pause ops see each other as "prior" and infer priorActive=false → no
        // transition → skip cap. Result: GCal master never gets UNTIL, and the live pause in the I7
        // smoke case left the recurring series un-capped. Strictly-before (ts, _id) ordering fixes it.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routineActive = makeRoutine(userId, {
            _id: 'routine-double-pause',
            calendarEventId: 'gcal-master-double',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            active: true,
            updatedTs: '2026-04-24T18:59:00.000Z',
        });
        await routinesDAO.insertOne(routineActive);
        await operationsDAO.insertOne({
            _id: 'op-prior-active',
            user: userId,
            deviceId: 'device-1',
            ts: '2026-04-24T18:59:00.000Z',
            entityType: 'routine',
            entityId: routineActive._id,
            opType: 'create',
            snapshot: routineActive,
        });

        const capSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'capRecurringEvent').mockResolvedValue(undefined);

        // First pause op lands (ts = 19:00:00.219Z, matching the live repro).
        const pausedSnapshot: RoutineInterface = { ...routineActive, active: false, updatedTs: '2026-04-24T19:00:00.219Z' };
        await routinesDAO.replaceById(routineActive._id, pausedSnapshot);
        const pauseOp1: OperationInterface = {
            _id: 'op-pause-1',
            user: userId,
            deviceId: 'device-1',
            ts: '2026-04-24T19:00:00.219Z',
            entityType: 'routine',
            entityId: pausedSnapshot._id,
            opType: 'update',
            snapshot: pausedSnapshot,
        };
        await operationsDAO.insertOne(pauseOp1);
        await maybePushToGCal(pauseOp1, mockBuildProvider());

        // Second pause op lands (ts = 19:00:00.435Z) — same snapshot (active still false).
        const pauseOp2: OperationInterface = {
            _id: 'op-pause-2',
            user: userId,
            deviceId: 'device-1',
            ts: '2026-04-24T19:00:00.435Z',
            entityType: 'routine',
            entityId: pausedSnapshot._id,
            opType: 'update',
            snapshot: { ...pausedSnapshot, updatedTs: '2026-04-24T19:00:00.435Z' },
        };
        await operationsDAO.insertOne(pauseOp2);
        await maybePushToGCal(pauseOp2, mockBuildProvider());

        expect(capSpy).toHaveBeenCalledOnce();
        expect(capSpy).toHaveBeenCalledWith('gcal-master-double', expect.stringMatching(/^\d{8}T235959Z$/), 'primary', 'Asia/Jerusalem');
    });

    it('readPriorActiveFlag: same-updatedTs collision is resolved by op._id, not timestamp', async () => {
        // Two devices pushed concurrently and produced ops with identical updatedTs on the routine
        // snapshot. The prior op is the active=true create; the new op flips to active=false.
        // Classifying by updatedTs would fail to exclude the new op; classifying by op._id succeeds.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const sharedUpdatedTs = '2026-01-06T10:00:00.000Z';
        const routineCreate = makeRoutine(userId, {
            _id: 'routine-collision',
            calendarEventId: 'gcal-master-collision',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            active: true,
            updatedTs: sharedUpdatedTs,
        });
        await routinesDAO.insertOne(routineCreate);
        await operationsDAO.insertOne({
            _id: 'op-create',
            user: userId,
            deviceId: 'device-1',
            ts: sharedUpdatedTs,
            entityType: 'routine',
            entityId: routineCreate._id,
            opType: 'create',
            snapshot: routineCreate,
        });

        const capSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'capRecurringEvent').mockResolvedValue(undefined);

        // New op: same updatedTs, but active=false. Must be recognized as a transition → cap.
        const pausedSnapshot: RoutineInterface = { ...routineCreate, active: false };
        await routinesDAO.replaceById(routineCreate._id, pausedSnapshot);
        await maybePushToGCal(
            makeOp(userId, {
                _id: 'op-pause-collision',
                entityType: 'routine',
                entityId: pausedSnapshot._id,
                snapshot: pausedSnapshot,
                ts: sharedUpdatedTs,
            }),
            mockBuildProvider(),
        );

        expect(capSpy).toHaveBeenCalledOnce();
    });

    it('pause batch with N concurrent item-trash ops: cap fires; per-instance cancellations are skipped', async () => {
        // Regression: when the user pauses a routine, the client emits one routine-pause op plus
        // N item-trash ops for the future generated items in a single sync-push batch. All N+1
        // pushbacks ran in parallel. The N parallel `cancelRecurringInstance` patches against GCal
        // raced with `capRecurringEvent` and dropped the just-written UNTIL from the master's
        // recurrence. Fix: when the routine is paused, skip per-instance cancellations entirely —
        // the cap covers them.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routineActive = makeRoutine(userId, {
            _id: 'routine-batch-pause',
            calendarEventId: 'gcal-master-batch-pause',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            active: true,
            updatedTs: '2026-01-10T09:00:00.000Z',
        });
        await routinesDAO.insertOne(routineActive);
        // Seed prior op (active=true) so handleRoutinePush sees the active→inactive transition.
        await operationsDAO.insertOne({
            _id: 'op-batch-prior',
            user: userId,
            deviceId: 'device-1',
            ts: '2026-01-10T09:00:00.000Z',
            entityType: 'routine',
            entityId: routineActive._id,
            opType: 'create',
            snapshot: routineActive,
        });

        // Mirror the client batch: routine flips to active=false in the DB BEFORE pushbacks run
        // (sync.ts applies entity ops before fanning out push-back). Each item-trash op carries a
        // routine-generated calendar item snapshot.
        const pausedSnapshot: RoutineInterface = { ...routineActive, active: false, updatedTs: '2026-01-10T10:00:00.000Z' };
        await routinesDAO.replaceById(routineActive._id, pausedSnapshot);

        const capSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'capRecurringEvent').mockResolvedValue(undefined);
        const cancelSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockResolvedValue(undefined);

        const itemCount = 5;
        const itemOps: OperationInterface[] = Array.from({ length: itemCount }, (_, i) => {
            const day = dayjs('2026-01-11').add(i, 'day').format('YYYY-MM-DD');
            const trashedItem: ItemInterface = {
                _id: `item-trash-${i}`,
                user: userId,
                status: 'trash',
                title: `Standup ${day}`,
                routineId: routineActive._id,
                timeStart: `${day}T09:00:00`,
                timeEnd: `${day}T09:30:00`,
                createdTs: '2026-01-10T08:00:00.000Z',
                updatedTs: '2026-01-10T10:00:00.000Z',
            };
            return {
                _id: `op-trash-${i}`,
                user: userId,
                deviceId: 'device-1',
                ts: '2026-01-10T10:00:00.000Z',
                entityType: 'item',
                entityId: trashedItem._id!,
                opType: 'update',
                snapshot: trashedItem,
            };
        });
        const pauseOp: OperationInterface = {
            _id: 'op-batch-pause',
            user: userId,
            deviceId: 'device-1',
            ts: '2026-01-10T10:00:00.000Z',
            entityType: 'routine',
            entityId: pausedSnapshot._id,
            opType: 'update',
            snapshot: pausedSnapshot,
        };
        await operationsDAO.insertMany([...itemOps, pauseOp]);

        // Fan out pushbacks in parallel — same shape as sync.ts line 200.
        await Promise.all([...itemOps, pauseOp].map((op) => maybePushToGCal(op, mockBuildProvider())));

        expect(capSpy).toHaveBeenCalledOnce();
        expect(capSpy).toHaveBeenCalledWith('gcal-master-batch-pause', expect.stringMatching(/^\d{8}T235959Z$/), 'primary', 'Asia/Jerusalem');
        // Per-instance cancellations must be skipped when the routine is paused — racing them
        // against the cap caused GCal to drop UNTIL from the master.
        expect(cancelSpy).not.toHaveBeenCalled();
    });

    it('resume heals stale link AND regenerated items inherit the healed integration ids (not the dead snapshot ids)', async () => {
        // Regression for the resume-side mirror of the disconnect/reconnect bug:
        // pushRoutineResume calls pushExistingRoutineToGCal first → resolvePushContext heals the
        // routine row in place. Without the in-resume re-read, regenerateFutureRoutineItems uses
        // the stale in-memory snapshot and stamps the gone integration ids onto every fresh item.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // Current (post-reconnect) integration + default config.
        await insertIntegrationWithConfig(userId);

        // Paused routine pointing at the gone integration. Daily rrule + 09:00 timed template so
        // resume regenerates at least one occurrence inside the 2-month horizon.
        const pausedRoutine = makeRoutine(userId, {
            _id: 'routine-stale-resume',
            calendarEventId: 'gcal-master-stale-resume',
            calendarIntegrationId: 'int-old',
            calendarSyncConfigId: 'sync-config-old',
            active: false,
            rrule: 'FREQ=DAILY',
            calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            updatedTs: '2026-01-10T09:00:00.000Z',
        });
        await routinesDAO.insertOne(pausedRoutine);
        await operationsDAO.insertOne({
            _id: 'op-paused-stale-prior',
            user: userId,
            deviceId: 'device-1',
            ts: '2026-01-10T09:00:00.000Z',
            entityType: 'routine',
            entityId: pausedRoutine._id,
            opType: 'update',
            snapshot: pausedRoutine,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringEvent').mockResolvedValue(undefined);

        const resumedSnapshot: RoutineInterface = { ...pausedRoutine, active: true, updatedTs: '2026-01-10T11:00:00.000Z' };
        await routinesDAO.replaceById(pausedRoutine._id, resumedSnapshot);
        await maybePushToGCal(
            makeOp(userId, {
                _id: 'op-resume-stale-current',
                entityType: 'routine',
                entityId: resumedSnapshot._id,
                snapshot: resumedSnapshot,
                ts: '2026-01-10T11:00:00.000Z',
            }),
            mockBuildProvider(),
        );

        // Routine row itself was healed by pushExistingRoutineToGCal.
        const healedRoutine = await routinesDAO.findByOwnerAndId(pausedRoutine._id, userId);
        expect(healedRoutine!.calendarIntegrationId).toBe('int-1');
        expect(healedRoutine!.calendarSyncConfigId).toBe('sync-config-1');

        // The actual regression: every regenerated calendar item must reference the HEALED ids,
        // not the dead snapshot ids. Pre-fix, they would all be stamped 'int-old' / 'sync-config-old'.
        const generated = await itemsDAO.findArray({ user: userId, routineId: pausedRoutine._id, status: 'calendar' });
        expect(generated.length).toBeGreaterThan(0);
        for (const item of generated) {
            expect(item.calendarIntegrationId).toBe('int-1');
            expect(item.calendarSyncConfigId).toBe('sync-config-1');
        }
    });
});

// ─── invalid_grant escalation ────────────────────────────────────────────────

describe('integration auth status — sync, pushback, OAuth reconnect', () => {
    it('returns HTTP 410 + integration_revoked from the sync endpoint when status=revoked', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const revokedAt = dayjs().toISOString();
        const suspendedAt = dayjs().subtract(25, 'hour').toISOString();
        await insertIntegrationWithConfig(userId, { status: 'revoked', suspendedAt, revokedAt });

        const watchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });

        expect(res.status).toBe(410);
        const body = (await res.json()) as { error: string; integrationId: string; revokedAt: string; suspendedAt: string };
        expect(body.error).toBe('integration_revoked');
        expect(body.integrationId).toBe('int-1');
        expect(body.revokedAt).toBe(revokedAt);
        expect(body.suspendedAt).toBe(suspendedAt);
        // No provider call attempted — short-circuit before sync.
        expect(watchSpy).not.toHaveBeenCalled();
    });

    it('pushback against a suspended integration is a no-op (no GCal calls)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const suspendedAt = dayjs().toISOString();
        await insertIntegrationWithConfig(userId, { status: 'suspended', suspendedAt });

        const item: ItemInterface = {
            _id: 'item-1',
            user: userId,
            title: 'Edited locally',
            status: 'calendar',
            timeStart: '2026-06-01T10:00:00Z',
            timeEnd: '2026-06-01T10:30:00Z',
            calendarEventId: 'gcal-evt-1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        };
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue();
        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue();

        const op: OperationInterface = {
            _id: 'op-1',
            user: userId,
            entityType: 'item',
            entityId: 'item-1',
            opType: 'update',
            ts: dayjs().toISOString(),
            snapshot: item,
        };
        await maybePushToGCal(
            op,
            () => new GoogleCalendarProvider({ accessToken: 'at', refreshToken: 'rt', tokenExpiry: dayjs().toISOString() }, async () => {}),
        );

        // Both `provider.updateEvent` and `provider.deleteEvent` must NOT be called — the suspended
        // status short-circuits inside resolvePushContext.
        expect(updateSpy).not.toHaveBeenCalled();
        expect(deleteSpy).not.toHaveBeenCalled();
    });

    it('OAuth reconnect (upsertEncrypted) flips a revoked row back to active and unsets escalation timestamps', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // Seed an existing revoked integration for this user.
        await calendarIntegrationsDAO.insertEncrypted(
            makeIntegration(userId, {
                status: 'revoked',
                suspendedAt: dayjs().subtract(2, 'day').toISOString(),
                revokedAt: dayjs().subtract(1, 'day').toISOString(),
                lastAuthErrorAt: dayjs().subtract(1, 'day').toISOString(),
            }),
        );

        // Simulate the OAuth callback: upsertEncrypted is what the callback ultimately calls.
        const now = dayjs().toISOString();
        await calendarIntegrationsDAO.upsertEncrypted({
            _id: 'int-1',
            user: userId,
            provider: 'google',
            accessToken: 'fresh-at',
            refreshToken: 'fresh-rt',
            tokenExpiry: dayjs().add(1, 'hour').toISOString(),
            createdTs: now,
            updatedTs: now,
        });

        const refreshed = await calendarIntegrationsDAO.findById('int-1');
        expect(refreshed?.status).toBe('active');
        expect(refreshed?.suspendedAt).toBeUndefined();
        expect(refreshed?.revokedAt).toBeUndefined();
        expect(refreshed?.lastAuthErrorAt).toBeUndefined();
    });
});
