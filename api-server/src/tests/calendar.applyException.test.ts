/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import dayjs from 'dayjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import type { RoutineInterface } from '../types/entities.js';
import {
    app,
    getUserId,
    insertIntegrationWithConfig,
    loginAsAlice,
    makeRoutine,
    makeSyncConfig,
    mockUserInfoEmail,
    useCalendarTestLifecycle,
} from './calendarTestKit.js';
import { authenticatedRequest, SESSION_COOKIE } from './helpers.js';

useCalendarTestLifecycle();

// ─── applyExceptionToItems — instance-id lookup, fallback, and create-on-miss ──────────────

describe('applyExceptionToItems — tiered lookup + create-on-miss', () => {
    beforeEach(() => {
        // Same default as the upsert-paths block: listEventsFull is called per sync.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-instance' });
    });

    async function setupRoutineAndIntegration(userId: string): Promise<RoutineInterface> {
        await insertIntegrationWithConfig(userId);
        const routine = makeRoutine(userId, { calendarEventId: 'gcal-evt-master', calendarIntegrationId: 'int-1', calendarSyncConfigId: 'sync-config-1' });
        await routinesDAO.insertOne(routine);
        return routine;
    }

    it('preferred lookup by calendarInstanceEventId hits the right item even when timeStart no longer matches originalDate', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await setupRoutineAndIntegration(userId);

        const instanceEventId = 'gcal-evt-master_20260519T060000Z';
        // Insert an item whose `timeStart` has already been moved to a different date — only the
        // `calendarInstanceEventId` ties it back to the May 19 occurrence.
        await itemsDAO.insertOne({
            _id: 'item-instance',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            calendarInstanceEventId: instanceEventId,
            timeStart: '2026-05-20T08:00:00Z',
            timeEnd: '2026-05-20T08:30:00Z',
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate: '2026-05-19',
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: '2026-05-24T09:30:00Z',
                newTimeEnd: '2026-05-24T10:30:00Z',
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updated = await itemsDAO.findByOwnerAndId('item-instance', userId);
        expect(updated?.timeStart).toBe('2026-05-24T09:30:00Z');
        expect(updated?.timeEnd).toBe('2026-05-24T10:30:00Z');

        const allForRoutine = await itemsDAO.findArray({ user: userId, routineId: 'routine-1' });
        // CRITICAL: instance-id match prevents a phantom create.
        expect(allForRoutine).toHaveLength(1);
    });

    it('fallback to routineId + originalDate when no item carries calendarInstanceEventId (legacy row)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await setupRoutineAndIntegration(userId);

        // Legacy item — pre-rollout, no calendarInstanceEventId. The date-keyed fallback must still find it.
        await itemsDAO.insertOne({
            _id: 'item-legacy',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: '2026-05-19T06:00:00Z',
            timeEnd: '2026-05-19T06:30:00Z',
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate: '2026-05-19',
                type: 'modified',
                googleEventId: 'gcal-evt-master_20260519T060000Z',
                newTimeStart: '2026-05-19T08:30:00Z',
                newTimeEnd: '2026-05-19T09:00:00Z',
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updated = await itemsDAO.findByOwnerAndId('item-legacy', userId);
        expect(updated?.timeStart).toBe('2026-05-19T08:30:00Z');
        expect(updated?.timeEnd).toBe('2026-05-19T09:00:00Z');

        const allForRoutine = await itemsDAO.findArray({ user: userId, routineId: 'routine-1' });
        expect(allForRoutine).toHaveLength(1);
    });

    it('moved twice (REGRESSION): second move lands on the now-shifted item, no duplicate created', async () => {
        // This is the reported bug: a user moves the Tue 15:00 instance to Sun 12:30, then again
        // to Mon 14:00. The first move already shifted the item's `timeStart`, so a date-keyed
        // lookup for May 19 misses on the second move. With `calendarInstanceEventId` the second
        // move still finds the (shifted) item.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await setupRoutineAndIntegration(userId);

        const instanceEventId = 'gcal-evt-master_20260519T060000Z';
        await itemsDAO.insertOne({
            _id: 'item-moved',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            calendarInstanceEventId: instanceEventId,
            timeStart: '2026-05-19T06:00:00Z',
            timeEnd: '2026-05-19T06:30:00Z',
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        // First move: May 19 → May 24 (12:30 local — exact values are stand-ins).
        const getExceptionsSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions');
        getExceptionsSpy.mockResolvedValueOnce([
            {
                originalDate: '2026-05-19',
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: '2026-05-24T09:30:00Z',
                newTimeEnd: '2026-05-24T10:30:00Z',
            },
        ]);
        await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });

        const afterFirst = await itemsDAO.findByOwnerAndId('item-moved', userId);
        expect(afterFirst?.timeStart).toBe('2026-05-24T09:30:00Z');

        // Second move of the same instance: May 24 → May 25. The `originalDate` stays at May 19
        // (rrule slot didn't change). Pre-fix: date-keyed lookup found nothing because the item
        // was already at May 24. Post-fix: `calendarInstanceEventId` resolves it directly.
        getExceptionsSpy.mockResolvedValueOnce([
            {
                originalDate: '2026-05-19',
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: '2026-05-25T11:00:00Z',
                newTimeEnd: '2026-05-25T12:00:00Z',
            },
        ]);
        await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });

        const afterSecond = await itemsDAO.findByOwnerAndId('item-moved', userId);
        expect(afterSecond?.timeStart).toBe('2026-05-25T11:00:00Z');
        expect(afterSecond?.timeEnd).toBe('2026-05-25T12:00:00Z');

        const allForRoutine = await itemsDAO.findArray({ user: userId, routineId: 'routine-1' });
        expect(allForRoutine).toHaveLength(1);
    });

    it('create-on-miss: modified exception with no matching item inserts a fresh calendar item', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await setupRoutineAndIntegration(userId);
        // No item seeded — the exception has nothing to find via either tier.

        // Dates are relative to today so the exception is always in the FUTURE — otherwise the
        // `isExceptionBeforeToday` past-cutoff guard skips the create-on-miss and the test rots the
        // day after a hardcoded date passes. originalDate / move date / instance id stay consistent.
        const originalDate = dayjs().add(2, 'day').format('YYYY-MM-DD');
        const movedStart = dayjs().add(3, 'day').hour(7).minute(0).second(0).millisecond(0);
        const movedTimeStart = movedStart.utc().format('YYYY-MM-DDTHH:mm:ss[Z]');
        const movedTimeEnd = movedStart.add(30, 'minute').utc().format('YYYY-MM-DDTHH:mm:ss[Z]');
        const instanceEventId = `gcal-evt-master_${originalDate.replace(/-/g, '')}T060000Z`;
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate,
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: movedTimeStart,
                newTimeEnd: movedTimeEnd,
                title: 'Standup (moved)',
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const created = await itemsDAO.findArray({ user: userId, routineId: 'routine-1', calendarInstanceEventId: instanceEventId } as never);
        expect(created).toHaveLength(1);
        const [item] = created;
        if (!item) throw new Error('expected create-on-miss to insert one item');
        expect(item.status).toBe('calendar');
        expect(item.title).toBe('Standup (moved)');
        expect(item.timeStart).toBe(movedTimeStart);
        expect(item.timeEnd).toBe(movedTimeEnd);
        // Inherits the routine's integration link so the UI can group it under the right calendar.
        expect(item.calendarIntegrationId).toBe('int-1');
        expect(item.calendarSyncConfigId).toBe('sync-config-1');
    });

    it('create-on-miss does NOT fire for deleted exceptions', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await setupRoutineAndIntegration(userId);

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate: '2026-06-15', type: 'deleted', googleEventId: 'gcal-evt-master_20260615T060000Z' },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Deleted exception with no matching item must NOT spawn a phantom item.
        const itemsForRoutine = await itemsDAO.findArray({ user: userId, routineId: 'routine-1' });
        expect(itemsForRoutine).toHaveLength(0);

        // Positive assertion: prove the create branch was not taken. (The shape "0 items remain"
        // would silently pass even if a phantom create op were recorded — checking the op log
        // directly catches the path having been reached at all.)
        const createOps = await operationsDAO.findArray({ user: userId, entityType: 'item', opType: 'create' });
        expect(createOps).toHaveLength(0);
    });

    it('past-cutoff guard (REGRESSION): orphan-create is skipped for exceptions whose date is years in the past', async () => {
        // Repro for the fresh-reconnect bug: a yearly-birthday routine has `* […]` modified
        // exceptions from 2021/2022. On first reconnect, `getExceptions` returns them (since
        // lastSyncedTs is unset → epoch). Without the past-cutoff guard, each one materializes
        // as an ancient `calendar` item via `createItemForOrphanedException`.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await setupRoutineAndIntegration(userId);
        // No item seeded for the 2021 occurrence — orphan-create branch would normally fire.

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate: '2021-09-24',
                type: 'modified',
                googleEventId: 'gcal-evt-master_20210924',
                title: '* [Yael’s Birthday]',
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // No ancient `calendar` item materialized.
        const items = await itemsDAO.findArray({ user: userId, routineId: 'routine-1' });
        expect(items).toHaveLength(0);

        // Positive assertion: no item-create op was recorded either.
        const createOps = await operationsDAO.findArray({ user: userId, entityType: 'item', opType: 'create' });
        expect(createOps).toHaveLength(0);
    });

    it('past exception is still applied to an existing item (modify path is not blocked by the cutoff)', async () => {
        // The cutoff only short-circuits orphan-create. If an item already exists for the past
        // occurrence (e.g. a routine generated it before today), a modified exception must still
        // be applied so historical edits aren't silently dropped.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await setupRoutineAndIntegration(userId);

        const instanceEventId = 'gcal-evt-master_20210924';
        await itemsDAO.insertOne({
            _id: 'item-past-existing',
            user: userId,
            status: 'calendar',
            title: 'Yael’s Birthday',
            routineId: 'routine-1',
            calendarInstanceEventId: instanceEventId,
            timeStart: '2021-09-24',
            timeEnd: '2021-09-25',
            allDay: true,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate: '2021-09-24', type: 'modified', googleEventId: instanceEventId, title: '* [Yael’s Birthday]' },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Existing item picked up the title edit.
        const updated = await itemsDAO.findByOwnerAndId('item-past-existing', userId);
        expect(updated?.title).toBe('* [Yael’s Birthday]');
        // No phantom duplicate created.
        const allForRoutine = await itemsDAO.findArray({ user: userId, routineId: 'routine-1' });
        expect(allForRoutine).toHaveLength(1);
    });

    it('past-cutoff does NOT mis-flag a today, all-day exception in a west-of-UTC zone (LA)', async () => {
        // Regression for the date-vs-datetime comparison bug. The bug only fires in zones west of
        // UTC: `originalDate = today_LA` parses to `today_LA T00:00:00Z`, while
        // `startOfTodayInTz('America/Los_Angeles') = today_LA T07:00:00Z` (PDT). Pre-fix:
        // `T00:00:00Z < T07:00:00Z` → true → mis-flagged as past → orphan-create silently dropped.
        // Post-fix: YYYY-MM-DD string comparison in the calendar's timezone returns false.
        //
        // Call applyExceptionToItems directly so we control `ctx.timeZone` cleanly without having
        // to override the globally-mocked `getCalendarTimeZone` for a single test.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const routine = await setupRoutineAndIntegration(userId);

        const todayInLA = dayjs().tz('America/Los_Angeles').format('YYYY-MM-DD');
        const instanceEventId = `gcal-evt-master_${todayInLA.replaceAll('-', '')}`;
        const { applyExceptionToItems } = await import('../routes/calendar.js');
        const ctx: Parameters<typeof applyExceptionToItems>[2] = {
            userId,
            now: dayjs().toISOString(),
            ops: [],
            timeZone: 'America/Los_Angeles',
        };
        await applyExceptionToItems(
            routine,
            { originalDate: todayInLA, type: 'modified', googleEventId: instanceEventId, title: 'Today (all-day, edited)' },
            ctx,
        );

        const created = await itemsDAO.findArray({ user: userId, routineId: 'routine-1' });
        expect(created).toHaveLength(1);
    });

    it('past-cutoff does NOT block a move FROM the past INTO the future', async () => {
        // newTimeStart wins over originalDate when present: a series instance whose original date
        // was in the past but has been moved to a future date should still materialize via
        // orphan-create. Otherwise users would lose calendar items they explicitly rescheduled.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await setupRoutineAndIntegration(userId);

        const instanceEventId = 'gcal-evt-master_20210924';
        const futureStart = dayjs().add(60, 'day').format('YYYY-MM-DDTHH:mm:ss');
        const futureEnd = dayjs().add(60, 'day').add(30, 'minute').format('YYYY-MM-DDTHH:mm:ss');
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate: '2021-09-24',
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: futureStart,
                newTimeEnd: futureEnd,
                title: 'Yael’s Birthday (rescheduled)',
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const created = await itemsDAO.findArray({ user: userId, routineId: 'routine-1', calendarInstanceEventId: instanceEventId } as never);
        expect(created).toHaveLength(1);
        const [item] = created;
        if (!item) throw new Error('expected the rescheduled occurrence to materialize');
        expect(item.timeStart).toBe(futureStart);
    });

    it('legacy row moved twice (no calendarInstanceEventId): first move via fallback, second move converges with no duplicate', async () => {
        // Pre-rollout shape: routine-generated item has NO `calendarInstanceEventId`. The first
        // move hits the date-keyed fallback OK. The second move would historically miss (item's
        // timeStart already shifted off the originalDate) — assert we end up with one item, not two.
        // Dates are computed relative to "today" so the past-event guard doesn't filter them out
        // when the suite is run on a future calendar day.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await setupRoutineAndIntegration(userId);

        const originalDate = dayjs().add(3, 'day').format('YYYY-MM-DD');
        const move1Date = dayjs().add(5, 'day').format('YYYY-MM-DD');
        const move2Date = dayjs().add(7, 'day').format('YYYY-MM-DD');
        const originalTimeStart = `${originalDate}T06:00:00Z`;
        const originalTimeEnd = `${originalDate}T06:30:00Z`;

        await itemsDAO.insertOne({
            _id: 'item-legacy-moved',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            // No calendarInstanceEventId — this is the legacy shape.
            timeStart: originalTimeStart,
            timeEnd: originalTimeEnd,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        const instanceEventId = `gcal-evt-master_${originalDate.replace(/-/g, '')}T060000Z`;
        const getExceptionsSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions');

        // Move 1: originalDate → move1Date. Fallback (routineId + date) finds the row on originalDate.
        getExceptionsSpy.mockResolvedValueOnce([
            {
                originalDate,
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: `${move1Date}T09:30:00Z`,
                newTimeEnd: `${move1Date}T10:30:00Z`,
            },
        ]);
        await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });

        // Move 1 resolved via the date-keyed fallback AND backfilled the instance id onto the
        // legacy row, so move 2 hits the tier-1 id lookup directly — no create-on-miss, no
        // duplicate. (Historically this scenario left two rows: the shifted legacy row plus a
        // fresh create-on-miss row.)
        const afterFirst = await itemsDAO.findByOwnerAndId('item-legacy-moved', userId);
        expect(afterFirst?.calendarInstanceEventId).toBe(instanceEventId);
        expect(afterFirst?.timeStart).toBe(`${move1Date}T09:30:00Z`);

        // Move 2 of the SAME instance: move1Date → move2Date.
        getExceptionsSpy.mockResolvedValueOnce([
            {
                originalDate,
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: `${move2Date}T11:00:00Z`,
                newTimeEnd: `${move2Date}T12:00:00Z`,
            },
        ]);
        await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });

        const allForRoutine = await itemsDAO.findArray({ user: userId, routineId: 'routine-1' });
        expect(allForRoutine).toHaveLength(1);
        const [survivor] = allForRoutine;
        if (!survivor) throw new Error('expected exactly one row for the moved instance');
        expect(survivor._id).toBe('item-legacy-moved');
        expect(survivor.calendarInstanceEventId).toBe(instanceEventId);
        expect(survivor.timeStart).toBe(`${move2Date}T11:00:00Z`);
        expect(survivor.timeEnd).toBe(`${move2Date}T12:00:00Z`);
    });

    it('re-delivered exception on an already-shifted legacy row (REGRESSION): instant-keyed tier 3 patches it, no duplicate', async () => {
        // The reported duplicate-item bug: an earlier apply already shifted the legacy row (no
        // `calendarInstanceEventId`) to the move target, storing the time in a DIFFERENT offset
        // representation (UTC) than the exception carries (+03:00). GCal re-reports the same
        // exception (`getExceptions` is a time-range query) → tier 1 misses (no id), tier 2 misses
        // (row no longer at originalDate). Pre-fix, create-on-miss inserted a duplicate row for
        // the same instant. Tier 3 must match by instant and backfill the id instead.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const originalDate = dayjs().add(3, 'day').format('YYYY-MM-DD');
        const moveDate = dayjs().add(10, 'day').format('YYYY-MM-DD');
        const movedStartOffset = `${moveDate}T07:00:00+03:00`;
        const movedEndOffset = `${moveDate}T08:00:00+03:00`;
        const routine = makeRoutine(userId, {
            calendarEventId: 'gcal-evt-master',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            // Pre-merge state: the exception was already applied and recorded on the routine.
            routineExceptions: [{ date: originalDate, type: 'modified', newTimeStart: movedStartOffset, newTimeEnd: movedEndOffset }],
        });
        await routinesDAO.insertOne(routine);

        // The legacy row sits at the SAME instant as the exception's target, but stored in UTC.
        await itemsDAO.insertOne({
            _id: 'item-legacy-shifted',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: `${moveDate}T04:00:00.000Z`,
            timeEnd: `${moveDate}T05:00:00.000Z`,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        const instanceEventId = `gcal-evt-master_${originalDate.replace(/-/g, '')}T040000Z`;
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate,
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: movedStartOffset,
                newTimeEnd: movedEndOffset,
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const allForRoutine = await itemsDAO.findArray({ user: userId, routineId: 'routine-1' });
        expect(allForRoutine).toHaveLength(1);
        const [survivor] = allForRoutine;
        if (!survivor) throw new Error('expected exactly one row for the re-delivered exception');
        expect(survivor._id).toBe('item-legacy-shifted');
        // Tier 3 matched → the id got backfilled so future exceptions hit tier 1.
        expect(survivor.calendarInstanceEventId).toBe(instanceEventId);
        expect(survivor.status).toBe('calendar');
    });

    it('deleted exception on an already-shifted legacy row: instant-keyed tier 3 finds and trashes it (no ghost item)', async () => {
        // Symmetric variant: the instance was moved earlier (legacy row shifted, no instance id),
        // then deleted on GCal. Tier 2's date-keyed lookup misses the shifted row, and deletes
        // have no create-on-miss — pre-fix the row survived forever as a ghost. Tier 3 keys on the
        // routine's stored prior `newTimeStart` for that date and trashes the row.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const originalDate = dayjs().add(4, 'day').format('YYYY-MM-DD');
        const moveDate = dayjs().add(9, 'day').format('YYYY-MM-DD');
        const routine = makeRoutine(userId, {
            calendarEventId: 'gcal-evt-master',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            routineExceptions: [{ date: originalDate, type: 'modified', newTimeStart: `${moveDate}T07:00:00+03:00`, newTimeEnd: `${moveDate}T08:00:00+03:00` }],
        });
        await routinesDAO.insertOne(routine);

        await itemsDAO.insertOne({
            _id: 'item-legacy-deleted',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: `${moveDate}T04:00:00.000Z`,
            timeEnd: `${moveDate}T05:00:00.000Z`,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate,
                type: 'deleted',
                googleEventId: `gcal-evt-master_${originalDate.replace(/-/g, '')}T040000Z`,
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const ghost = await itemsDAO.findByOwnerAndId('item-legacy-deleted', userId);
        expect(ghost?.status).toBe('trash');
    });

    it('tier 3 matches an offset-NAIVE legacy timeStart against an offset-explicit exception (calendar-tz parse, not server-local)', async () => {
        // Routine-generated rows store wall-clock naive `timeStart` (no Z / offset). The stored
        // exception carries +03:00. The instants only line up when the naive string is parsed in
        // the CALENDAR's timezone (Asia/Jerusalem fixture) — a server-local parse (UTC on Cloud
        // Run) skews by the offset and misses, falling through to a duplicate create.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const originalDate = dayjs().add(5, 'day').format('YYYY-MM-DD');
        const moveDate = dayjs().add(11, 'day').format('YYYY-MM-DD');
        const movedStartOffset = `${moveDate}T07:00:00+03:00`;
        const movedEndOffset = `${moveDate}T08:00:00+03:00`;
        const routine = makeRoutine(userId, {
            calendarEventId: 'gcal-evt-master',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            routineExceptions: [{ date: originalDate, type: 'modified', newTimeStart: movedStartOffset, newTimeEnd: movedEndOffset }],
        });
        await routinesDAO.insertOne(routine);

        // Same wall-clock instant as the exception, stored offset-naive (Jerusalem wall time).
        await itemsDAO.insertOne({
            _id: 'item-legacy-naive',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: `${moveDate}T07:00:00`,
            timeEnd: `${moveDate}T08:00:00`,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        const instanceEventId = `gcal-evt-master_${originalDate.replace(/-/g, '')}T040000Z`;
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate, type: 'modified', googleEventId: instanceEventId, newTimeStart: movedStartOffset, newTimeEnd: movedEndOffset },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const allForRoutine = await itemsDAO.findArray({ user: userId, routineId: 'routine-1' });
        expect(allForRoutine).toHaveLength(1);
        const [survivor] = allForRoutine;
        if (!survivor) throw new Error('expected one row for the naive-timeStart instance');
        expect(survivor._id).toBe('item-legacy-naive');
        expect(survivor.calendarInstanceEventId).toBe(instanceEventId);
    });

    it('dead-twin squat on the instance id: the move still lands, only the id backfill is skipped', async () => {
        // The `(user, calendarInstanceEventId)` unique index is NOT status-scoped: a trash row from
        // an earlier routine generation can squat the id indefinitely. The backfilled update then
        // E11000s — the exception's time move must still be applied (retry without the backfill),
        // not silently dropped on every sync.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await setupRoutineAndIntegration(userId);

        const originalDate = dayjs().add(6, 'day').format('YYYY-MM-DD');
        const moveDate = dayjs().add(8, 'day').format('YYYY-MM-DD');
        const instanceEventId = `gcal-evt-master_${originalDate.replace(/-/g, '')}T060000Z`;

        // Dead twin on a FOREIGN routine squatting the instance id (tier 1 skips it: not status 'calendar').
        await itemsDAO.insertOne({
            _id: 'item-dead-squatter',
            user: userId,
            status: 'trash',
            title: 'Standup (old generation)',
            routineId: 'routine-prior-generation',
            calendarInstanceEventId: instanceEventId,
            timeStart: `${originalDate}T06:00:00Z`,
            timeEnd: `${originalDate}T06:30:00Z`,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });
        // Live legacy row at the original date — tier 2 resolves it.
        await itemsDAO.insertOne({
            _id: 'item-live-legacy',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: `${originalDate}T06:00:00Z`,
            timeEnd: `${originalDate}T06:30:00Z`,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate,
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: `${moveDate}T09:30:00Z`,
                newTimeEnd: `${moveDate}T10:30:00Z`,
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // The move landed despite the squat…
        const moved = await itemsDAO.findByOwnerAndId('item-live-legacy', userId);
        expect(moved?.timeStart).toBe(`${moveDate}T09:30:00Z`);
        expect(moved?.timeEnd).toBe(`${moveDate}T10:30:00Z`);
        // …the backfill was skipped (id still squatted), and the squatter is untouched.
        expect(moved?.calendarInstanceEventId).toBeUndefined();
        const squatter = await itemsDAO.findByOwnerAndId('item-dead-squatter', userId);
        expect(squatter?.status).toBe('trash');
        expect(squatter?.calendarInstanceEventId).toBe(instanceEventId);
    });

    it('tier 3 ambiguity (two legacy rows at the same instant): deleted exception trashes NOTHING', async () => {
        // Two legacy occurrences legitimately at the same instant are indistinguishable — a wrong
        // guess on a deleted exception would trash a live occurrence the user never cancelled.
        // Ambiguity must degrade to a miss (both rows survive), never to data loss.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const originalDate = dayjs().add(7, 'day').format('YYYY-MM-DD');
        const moveDate = dayjs().add(12, 'day').format('YYYY-MM-DD');
        const routine = makeRoutine(userId, {
            calendarEventId: 'gcal-evt-master',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            routineExceptions: [{ date: originalDate, type: 'modified', newTimeStart: `${moveDate}T07:00:00+03:00`, newTimeEnd: `${moveDate}T08:00:00+03:00` }],
        });
        await routinesDAO.insertOne(routine);

        const sharedRow = {
            user: userId,
            status: 'calendar' as const,
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: `${moveDate}T04:00:00.000Z`,
            timeEnd: `${moveDate}T05:00:00.000Z`,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        };
        await itemsDAO.insertOne({ _id: 'item-ambiguous-a', ...sharedRow });
        await itemsDAO.insertOne({ _id: 'item-ambiguous-b', ...sharedRow });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate, type: 'deleted', googleEventId: `gcal-evt-master_${originalDate.replace(/-/g, '')}T040000Z` },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const rowA = await itemsDAO.findByOwnerAndId('item-ambiguous-a', userId);
        const rowB = await itemsDAO.findByOwnerAndId('item-ambiguous-b', userId);
        expect(rowA?.status).toBe('calendar');
        expect(rowB?.status).toBe('calendar');
    });

    it('concurrent updatedTs bump between resolve and apply: modified exception is skipped, not clobbered', async () => {
        // Simulates the race the reviewer flagged: `resolveExceptionTarget` reads an item, then
        // a /sync/push edit lands between read and apply (bumping updatedTs). The updateOne
        // conditional on the stale updatedTs must matchCount=0 and skip — otherwise the apply
        // silently overwrites the user's edit.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await setupRoutineAndIntegration(userId);

        const instanceEventId = 'gcal-evt-master_20260701T060000Z';
        const initialUpdatedTs = dayjs().subtract(10, 'minute').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-race',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            calendarInstanceEventId: instanceEventId,
            timeStart: '2026-07-01T06:00:00Z',
            timeEnd: '2026-07-01T06:30:00Z',
            createdTs: initialUpdatedTs,
            updatedTs: initialUpdatedTs,
        });

        // Bump updatedTs BEFORE the exception lands — same effect as a concurrent /sync/push
        // racing in between resolveExceptionTarget and the apply's updateOne. Since vitest can't
        // truly interleave, we mutate first; the conditional updateOne sees a mismatched
        // updatedTs from the snapshot the resolver captured.
        const racingTs = dayjs().toISOString();
        await itemsDAO.updateOne({ _id: 'item-race', user: userId } as never, { $set: { title: 'User edited title', updatedTs: racingTs } });

        // Mock the resolver-internal findArray to return the STALE pre-race snapshot, exactly the
        // window we're guarding against. The actual write goes through the real DB.
        const findArraySpy = vi.spyOn(itemsDAO, 'findArray');
        let staleReturned = false;
        findArraySpy.mockImplementationOnce(async () => {
            staleReturned = true;
            return [
                {
                    _id: 'item-race',
                    user: userId,
                    status: 'calendar' as const,
                    title: 'Standup',
                    routineId: 'routine-1',
                    calendarInstanceEventId: instanceEventId,
                    timeStart: '2026-07-01T06:00:00Z',
                    timeEnd: '2026-07-01T06:30:00Z',
                    createdTs: initialUpdatedTs,
                    updatedTs: initialUpdatedTs, // stale
                },
            ];
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate: '2026-07-01',
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: '2026-07-02T08:00:00Z',
                newTimeEnd: '2026-07-02T08:30:00Z',
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);
        expect(staleReturned).toBe(true);

        // The user's racing edit must survive — title + timeStart unchanged from the racing write.
        const finalItem = await itemsDAO.findByOwnerAndId('item-race', userId);
        expect(finalItem?.title).toBe('User edited title');
        expect(finalItem?.timeStart).toBe('2026-07-01T06:00:00Z');
    });

    it('concurrent create race: two callers seeing target miss converge on one item (no duplicate)', async () => {
        // Real-world scenario the unique partial index guards: a webhook delivery and a manual
        // /calendar/integrations/:id/sync land within the same window, both see resolve miss,
        // both reach createItemForOrphanedException. The loser gets E11000 and falls through to
        // re-resolve + apply on the winner's row. End state: exactly one item.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const routine = await setupRoutineAndIntegration(userId);

        // Dynamic future dates — a hardcoded date rots into `isExceptionBeforeToday`'s past-cutoff
        // guard once the calendar catches up, making the orphan create silently skip.
        const originalDate = dayjs().add(10, 'day').format('YYYY-MM-DD');
        const movedStart = dayjs(`${originalDate}T09:00:00Z`).add(1, 'day').toISOString();
        const movedEnd = dayjs(`${originalDate}T09:30:00Z`).add(1, 'day').toISOString();
        const instanceEventId = `gcal-evt-master_${originalDate.replaceAll('-', '')}T060000Z`;
        const exception = {
            originalDate,
            type: 'modified' as const,
            googleEventId: instanceEventId,
            newTimeStart: movedStart,
            newTimeEnd: movedEnd,
            title: 'Standup (raced move)',
        };

        // Fire two concurrent applies of the same exception through the exported handler. Equivalent
        // to what syncRoutineExceptions does for each entry returned by getExceptions, but lets us
        // race without standing up the full /dev/* mount in this test app.
        const { applyExceptionToItems } = await import('../routes/calendar.js');
        const now = dayjs().toISOString();
        const ctx1: Parameters<typeof applyExceptionToItems>[2] = { userId, now, ops: [] };
        const ctx2: Parameters<typeof applyExceptionToItems>[2] = { userId, now, ops: [] };

        await Promise.all([applyExceptionToItems(routine, exception, ctx1), applyExceptionToItems(routine, exception, ctx2)]);

        // The race guard (unique partial index on calendarInstanceEventId) ensures only one row.
        const itemsForInstance = await itemsDAO.findArray({ user: userId, calendarInstanceEventId: instanceEventId } as never);
        expect(itemsForInstance).toHaveLength(1);
        const winner = itemsForInstance[0];
        if (!winner) throw new Error('expected one winner');
        // The winning row carries the move's title/time, regardless of which caller inserted.
        expect(winner.title).toBe('Standup (raced move)');
        expect(winner.timeStart).toBe(movedStart);
    });

    it('dead-twin demote (REGRESSION): trashed twin on a different routine is demoted so the active routine can insert', async () => {
        // Real-world scenario: a routine was paused or replaced. Its old items moved to `trash` but
        // still carry `calendarInstanceEventId`. When the active routine's exception sync runs, the
        // unique partial index `(user, calendarInstanceEventId)` fires E11000 on the insert. The
        // fix demotes the trashed twin (strips its instance id) and retries — UI sees the fresh row.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const activeRoutine = await setupRoutineAndIntegration(userId);

        // Date must be strictly after today-in-config-TZ; the past-cutoff guard in applyExceptionToItems
        // skips orphan-create otherwise. 7 days is well clear of any test-runner-vs-integration TZ skew.
        const futureDay = dayjs().add(7, 'day');
        const futureYmd = futureDay.format('YYYY-MM-DD');
        const futureYmdCompact = futureDay.format('YYYYMMDD');
        const instanceEventId = `gcal-evt-master_${futureYmdCompact}T123000Z`;
        const newStart = `${futureYmd}T14:00:00Z`;
        const newEnd = `${futureYmd}T15:00:00Z`;
        // Trashed twin on a DIFFERENT (paused) routine, still squatting the instance slot.
        await itemsDAO.insertOne({
            _id: 'item-trashed-twin',
            user: userId,
            status: 'trash',
            title: 'All-Hands (old)',
            routineId: 'routine-paused',
            calendarInstanceEventId: instanceEventId,
            timeStart: `${futureYmd}T12:30:00Z`,
            timeEnd: `${futureYmd}T13:30:00Z`,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate: futureYmd,
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: newStart,
                newTimeEnd: newEnd,
                title: 'All-Hands',
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Trashed twin's instance id is stripped — slot is freed.
        const demoted = await itemsDAO.findByOwnerAndId('item-trashed-twin', userId);
        expect(demoted?.calendarInstanceEventId).toBeUndefined();
        expect(demoted?.status).toBe('trash');

        // Active routine got its fresh `calendar` item with the freed instance id.
        const freshForActive = await itemsDAO.findArray({ user: userId, routineId: activeRoutine._id, status: 'calendar' });
        expect(freshForActive).toHaveLength(1);
        const [item] = freshForActive;
        if (!item) throw new Error('expected one fresh calendar item');
        expect(item.calendarInstanceEventId).toBe(instanceEventId);
        expect(item.timeStart).toBe(newStart);
        expect(item.title).toBe('All-Hands');
    });

    it('dead-twin demote: a `done` twin on a different routine is demoted just like a trashed twin', async () => {
        // Same logic as above but the dead occupant is a completed item (kept for history). `done`
        // rows also retain `calendarInstanceEventId` for echo matching and must be demotable.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const activeRoutine = await setupRoutineAndIntegration(userId);

        const futureDay = dayjs().add(7, 'day');
        const futureYmd = futureDay.format('YYYY-MM-DD');
        const futureYmdCompact = futureDay.format('YYYYMMDD');
        const instanceEventId = `gcal-evt-master_${futureYmdCompact}T123000Z`;
        const newStart = `${futureYmd}T14:00:00Z`;
        const newEnd = `${futureYmd}T15:00:00Z`;
        await itemsDAO.insertOne({
            _id: 'item-done-twin',
            user: userId,
            status: 'done',
            title: 'All-Hands (completed)',
            routineId: 'routine-paused',
            calendarInstanceEventId: instanceEventId,
            timeStart: `${futureYmd}T12:30:00Z`,
            timeEnd: `${futureYmd}T13:30:00Z`,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate: futureYmd,
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: newStart,
                newTimeEnd: newEnd,
                title: 'All-Hands',
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const demoted = await itemsDAO.findByOwnerAndId('item-done-twin', userId);
        expect(demoted?.calendarInstanceEventId).toBeUndefined();
        expect(demoted?.status).toBe('done');

        const freshForActive = await itemsDAO.findArray({ user: userId, routineId: activeRoutine._id, status: 'calendar' });
        expect(freshForActive).toHaveLength(1);
        const [item] = freshForActive;
        if (!item) throw new Error('expected one fresh calendar item');
        expect(item.calendarInstanceEventId).toBe(instanceEventId);
        expect(item.timeStart).toBe(newStart);
    });

    it('dead-twin demote: live `calendar` row on the SAME routine is NOT demoted (existing race-loser path runs)', async () => {
        // Sanity check that the new demote branch is narrowly scoped: a same-routine live row is
        // the legitimate race winner; we must NOT strip its instance id. The existing
        // applyExceptionAfterDuplicate path patches it via the standard modified-exception apply.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const activeRoutine = await setupRoutineAndIntegration(userId);

        const futureDay = dayjs().add(7, 'day');
        const futureYmd = futureDay.format('YYYY-MM-DD');
        const futureYmdCompact = futureDay.format('YYYYMMDD');
        const instanceEventId = `gcal-evt-master_${futureYmdCompact}T123000Z`;
        const newStart = `${futureYmd}T14:00:00Z`;
        const newEnd = `${futureYmd}T15:00:00Z`;
        // Live race-winner already inserted by some other path on the SAME routine.
        await itemsDAO.insertOne({
            _id: 'item-race-winner',
            user: userId,
            status: 'calendar',
            title: 'All-Hands (existing)',
            routineId: activeRoutine._id,
            calendarInstanceEventId: instanceEventId,
            timeStart: `${futureYmd}T12:30:00Z`,
            timeEnd: `${futureYmd}T13:30:00Z`,
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        // Force the orphan-create branch by spying on resolveExceptionTarget's findArray: return
        // empty so applyExceptionToItems treats it as a miss and reaches createItemForOrphanedException.
        const findArraySpy = vi.spyOn(itemsDAO, 'findArray');
        findArraySpy.mockImplementationOnce(async () => []); // preferred-lookup miss
        findArraySpy.mockImplementationOnce(async () => []); // fallback-lookup miss

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate: futureYmd,
                type: 'modified',
                googleEventId: instanceEventId,
                newTimeStart: newStart,
                newTimeEnd: newEnd,
                title: 'All-Hands (updated)',
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Existing live row is preserved AND received the modified-exception update via the race-loser path.
        const winner = await itemsDAO.findByOwnerAndId('item-race-winner', userId);
        expect(winner?.calendarInstanceEventId).toBe(instanceEventId);
        expect(winner?.title).toBe('All-Hands (updated)');
        expect(winner?.timeStart).toBe(newStart);

        // No second item created — applyExceptionAfterDuplicate patched the winner instead.
        const allForActive = await itemsDAO.findArray({ user: userId, routineId: activeRoutine._id });
        expect(allForActive).toHaveLength(1);
    });

    it("cross-account reconnect: routine markers and instance ids persist; the unlinked routine never joins B's exception sync", async () => {
        // Historic context: disconnect-with-keep on account A, reconnect to a DIFFERENT account B.
        // The old wipe-and-repush behavior cleared markers + stale instance ids so the routine could
        // be relinked/re-pushed under B (and stale ids then caused the duplicate-on-second-move
        // regression). Under leave-unlinked the routine simply STAYS unlinked — markers and instance
        // ids persist inertly, and only an explicit re-bind (simulated below) brings the routine into
        // B's exception sync, at which point the duplicate-protection invariant must still hold.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);

        // Seed: routine + items still bound to OLD account A. Items carry instance ids derived
        // from A's master id ('gcal-master-A'). The lastKnownCalendarIntegrationId points at a
        // defunct integration the user no longer owns.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-cross-account',
                lastKnownCalendarEventId: 'gcal-master-A',
                lastKnownCalendarIntegrationId: 'int-OLD-account-A',
                lastKnownCalendarSyncConfigId: 'sync-config-OLD',
            }),
        );
        await itemsDAO.insertOne({
            _id: 'item-cross-account',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-cross-account',
            calendarInstanceEventId: 'gcal-master-A_20260815T060000Z', // derived from A's master
            timeStart: '2026-08-15T06:00:00Z',
            timeEnd: '2026-08-15T06:30:00Z',
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        // Drive the OAuth reconnect for a NEW account B.
        const redirectRes = await authenticatedRequest(app, {
            method: 'GET',
            path: '/calendar/auth/google?login_hint=alice@example.com',
            sessionCookie,
        });
        const state = new URL(redirectRes.headers.get('location')!).searchParams.get('state')!;
        const { google } = await import('googleapis');
        vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockResolvedValueOnce({
            tokens: { access_token: 'B-at', refresh_token: 'B-rt', expiry_date: dayjs().add(1, 'hour').valueOf() },
        } as never);
        mockUserInfoEmail('alice@example.com');

        const callbackRes = await app.fetch(
            new Request(`http://localhost:4000/calendar/auth/google/callback?code=auth-B&state=${state}`, {
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
            }),
        );
        expect(callbackRes.status).toBe(302);

        // Leave-unlinked: the reconnect touches neither the routine's markers nor the item's stale
        // instance id. The routine is unlinked, so it does not participate in B's exception sync —
        // the stale id is inert until something explicitly re-binds the routine.
        const afterReconnect = await routinesDAO.findByOwnerAndId('routine-cross-account', userId);
        expect(afterReconnect?.lastKnownCalendarEventId).toBe('gcal-master-A');
        const itemAfterReconnect = await itemsDAO.findByOwnerAndId('item-cross-account', userId);
        expect(itemAfterReconnect?.calendarInstanceEventId).toBe('gcal-master-A_20260815T060000Z');

        // Simulate two moves under account B's master id after an EXPLICIT re-bind. The stale
        // instance id makes the preferred lookup miss; the first move lands via the originalDate
        // fallback. Create-on-miss may fire on the second move, but the unique partial index
        // ensures at most one new row — the invariant that must survive leave-unlinked.
        const integrationsB = await calendarIntegrationsDAO.findByUserDecrypted(userId);
        const liveIntegrationId = integrationsB[0]?._id;
        if (!liveIntegrationId) throw new Error('expected reconnected integration');
        // The sweep runs inside each manual sync below (full sync) and picks up the legacy
        // email-less marker best-effort; return "not found" so it skips (provenance unproven).
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(null);

        const instanceB1 = 'gcal-master-B_20260815T060000Z';
        const getExceptionsSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions');
        getExceptionsSpy.mockResolvedValueOnce([
            {
                originalDate: '2026-08-15',
                type: 'modified',
                googleEventId: instanceB1,
                newTimeStart: '2026-08-20T09:00:00Z',
                newTimeEnd: '2026-08-20T09:30:00Z',
            },
        ]);
        // Bind the routine to B so syncRoutineExceptions includes it on next pass.
        await routinesDAO.updateOne({ _id: 'routine-cross-account', user: userId } as never, {
            $set: { calendarEventId: 'gcal-master-B', calendarIntegrationId: liveIntegrationId, calendarSyncConfigId: 'sync-config-1' },
        });
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(userId, liveIntegrationId));
        await authenticatedRequest(app, { method: 'POST', path: `/calendar/integrations/${liveIntegrationId}/sync`, sessionCookie });

        // Second move of the SAME instance.
        getExceptionsSpy.mockResolvedValueOnce([
            {
                originalDate: '2026-08-15',
                type: 'modified',
                googleEventId: instanceB1,
                newTimeStart: '2026-08-21T10:00:00Z',
                newTimeEnd: '2026-08-21T10:30:00Z',
            },
        ]);
        await authenticatedRequest(app, { method: 'POST', path: `/calendar/integrations/${liveIntegrationId}/sync`, sessionCookie });

        // Critical: never more than one item per instance id, regardless of which path each move
        // took. Strictly worse than pre-Q2 would be 2+ items here.
        const itemsB = await itemsDAO.findArray({ user: userId, calendarInstanceEventId: instanceB1 } as never);
        expect(itemsB.length).toBeLessThanOrEqual(1);
        const allForRoutine = await itemsDAO.findArray({ user: userId, routineId: 'routine-cross-account' });
        expect(allForRoutine.length).toBeLessThanOrEqual(2);
    });

    it('same-account reconnect: markers are REWRITTEN to the live integration, not wiped (no gtd* clone)', async () => {
        // The duplicate-event bug: disconnect-with-keep on account A, reconnect to the SAME account A.
        // The disconnect markers (lastKnownCalendar*) carry the origin email; the reconnect's authorized
        // email matches it, so the markers must be REWRITTEN to the new integration id (every reconnect
        // mints a new id) — NOT wiped. Wiping would let the outbound backfill push the routine as a fresh
        // gtd* clone master alongside the real one that still lives on Google.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-same-account',
                lastKnownCalendarEventId: 'gcal-master-real',
                lastKnownCalendarIntegrationId: 'int-OLD-deleted',
                lastKnownCalendarSyncConfigId: 'sync-config-OLD',
                lastKnownCalendarAccountEmail: 'alice@example.com',
            }),
        );

        // Drive the OAuth reconnect for the SAME account (alice@example.com).
        const redirectRes = await authenticatedRequest(app, { method: 'GET', path: '/calendar/auth/google?login_hint=alice@example.com', sessionCookie });
        const state = new URL(redirectRes.headers.get('location')!).searchParams.get('state')!;
        const { google } = await import('googleapis');
        vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockResolvedValueOnce({
            tokens: { access_token: 'A2-at', refresh_token: 'A2-rt', expiry_date: dayjs().add(1, 'hour').valueOf() },
        } as never);
        mockUserInfoEmail('alice@example.com');
        const callbackRes = await app.fetch(
            new Request(`http://localhost:4000/calendar/auth/google/callback?code=auth-A2&state=${state}`, {
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
            }),
        );
        expect(callbackRes.status).toBe(302);

        const integrations = await calendarIntegrationsDAO.findByUserDecrypted(userId);
        const [liveIntegration] = integrations;
        if (!liveIntegration) throw new Error('expected reconnected integration');

        const afterRepair = await routinesDAO.findByOwnerAndId('routine-same-account', userId);
        // Marker survives — the real master id is intact so the inbound pull can strong-key relink.
        expect(afterRepair?.lastKnownCalendarEventId).toBe('gcal-master-real');
        // And its integration id is repointed at the LIVE integration (not the deleted one, not absent).
        expect(afterRepair?.lastKnownCalendarIntegrationId).toBe(liveIntegration._id);

        // The rewrite must record a convergence op — otherwise peer devices keep the dead int-OLD-deleted
        // marker in their local IDB forever and their pushback stays skipped. Assert the latest recorded op
        // carries the rewritten (live) integration id.
        const repairOps = await operationsDAO.findArray({ user: userId, entityType: 'routine', entityId: 'routine-same-account' });
        const [latestRepairOp] = repairOps.sort((a, b) => b.ts.localeCompare(a.ts));
        if (!latestRepairOp) throw new Error('expected a repair op for routine-same-account');
        expect(latestRepairOp.snapshot?.lastKnownCalendarIntegrationId).toBe(liveIntegration._id);
    });

    it('cross-account reconnect: a STAMPED different-account marker is left intact (not rewritten, not wiped)', async () => {
        // Genuine cross-account: disconnect-with-keep stamped origin email `other@example.com`, then reconnect
        // authorizes `alice@example.com`. Leave-unlinked: the marker must survive verbatim — wiping would
        // re-arm the outbound backfill (clone events on alice's calendar) and irreversibly sever the
        // original series, killing a later other@ reconnect's ability to relink. Rewriting would lie
        // about the marker's origin account.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-other-account',
                lastKnownCalendarEventId: 'gcal-master-other',
                lastKnownCalendarIntegrationId: 'int-OTHER-deleted',
                lastKnownCalendarSyncConfigId: 'sync-config-OTHER',
                lastKnownCalendarAccountEmail: 'other@example.com',
            }),
        );

        // Reconnect authorizes alice@example.com — a DIFFERENT account than the marker's origin.
        const redirectRes = await authenticatedRequest(app, { method: 'GET', path: '/calendar/auth/google?login_hint=alice@example.com', sessionCookie });
        const state = new URL(redirectRes.headers.get('location')!).searchParams.get('state')!;
        const { google } = await import('googleapis');
        vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockResolvedValueOnce({
            tokens: { access_token: 'B-at', refresh_token: 'B-rt', expiry_date: dayjs().add(1, 'hour').valueOf() },
        } as never);
        mockUserInfoEmail('alice@example.com');
        const callbackRes = await app.fetch(
            new Request(`http://localhost:4000/calendar/auth/google/callback?code=auth-B&state=${state}`, {
                headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
            }),
        );
        expect(callbackRes.status).toBe(302);

        const afterRepair = await routinesDAO.findByOwnerAndId('routine-other-account', userId);
        // Marker preserved verbatim — the routine stays unlinked (and unpushable) until other@ returns.
        expect(afterRepair?.lastKnownCalendarEventId).toBe('gcal-master-other');
        expect(afterRepair?.lastKnownCalendarIntegrationId).toBe('int-OTHER-deleted');
        expect(afterRepair?.lastKnownCalendarAccountEmail).toBe('other@example.com');
    });
});
