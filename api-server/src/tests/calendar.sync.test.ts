/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import dayjs from 'dayjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDeterministicGCalId, GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import * as sseConnections from '../lib/sseConnections.js';
import * as webPush from '../lib/webPush.js';
import { db } from '../loaders/mainLoader.js';
import type { GCalAttendee, ItemInterface } from '../types/entities.js';
import {
    app,
    getUserId,
    insertIntegrationWithConfig,
    loginAsAlice,
    makeIntegration,
    makeRoutine,
    makeSyncConfig,
    useCalendarTestLifecycle,
} from './calendarTestKit.js';
import { authenticatedRequest } from './helpers.js';

useCalendarTestLifecycle();

// ─── POST /calendar/integrations/:id/sync ─────────────────────────────────

describe('POST /calendar/integrations/:id/sync', () => {
    // listEventsFull is called by importCalendarEvents on every sync — mock it by default so
    // tests that focus on other behaviour don't need to set it up themselves.
    beforeEach(() => {
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });
    });

    it('returns 404 for an unknown integration', async () => {
        const sessionCookie = await loginAsAlice();
        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/bad-id/sync', sessionCookie });
        expect(res.status).toBe(404);
    });

    it('returns syncedRoutines: 0 when no routines are linked', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Mock the GoogleCalendarProvider so no real HTTP calls are made.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, syncedRoutines: 0 });
    });

    it('merges a deleted exception as type:skipped in routineExceptions', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const routine = makeRoutine(userId, { calendarEventId: 'gcal-evt-1', calendarIntegrationId: 'int-1' });
        await routinesDAO.insertOne(routine);

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([{ originalDate: '2025-06-02', type: 'deleted' }]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updated = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updated?.routineExceptions).toContainEqual({ date: '2025-06-02', type: 'skipped' });
    });

    it('skips the routine write + op when the merged exception set is unchanged (no-op churn guard)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Routine already carries the exact exception GCal will re-surface (getExceptions is a time-range,
        // not incremental, query — every fire re-returns the same rows). The merge reproduces an identical
        // list, so no routine write and no `update` op should be recorded for this routine.
        const routine = makeRoutine(userId, {
            calendarEventId: 'gcal-evt-noop',
            calendarIntegrationId: 'int-1',
            routineExceptions: [{ date: '2025-06-02', type: 'skipped' }],
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        await routinesDAO.insertOne(routine);

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([{ originalDate: '2025-06-02', type: 'deleted' }]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const ops = await operationsDAO.findArray({ entityId: 'routine-1', entityType: 'routine' });
        expect(ops).toHaveLength(0);
        // updatedTs untouched — the routine was not rewritten.
        const unchanged = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(unchanged?.updatedTs).toBe('2026-01-01T00:00:00.000Z');
    });

    it('skips the item write + op when a modified exception re-surfaces values the item already holds (no-op churn guard)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Routine already carries this exception, so syncRoutineExceptions' own guard short-circuits the
        // routine write. The item below already holds the exact times the modified exception re-surfaces,
        // so applyModifiedExceptionToOne must also skip — getExceptions is a time-range (not incremental)
        // query, so each webhook fire would otherwise rewrite this item with an identical snapshot.
        const newTimeStart = '2025-06-09T10:00:00Z';
        const newTimeEnd = '2025-06-09T10:30:00Z';
        const routine = makeRoutine(userId, {
            calendarEventId: 'gcal-evt-itemnoop',
            calendarIntegrationId: 'int-1',
            routineExceptions: [{ date: '2025-06-09', type: 'modified', newTimeStart, newTimeEnd }],
        });
        await routinesDAO.insertOne(routine);

        const itemTs = '2026-01-01T00:00:00.000Z';
        await itemsDAO.insertOne({
            _id: 'item-noop-ex',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            calendarInstanceEventId: 'inst-noop',
            timeStart: newTimeStart,
            timeEnd: newTimeEnd,
            createdTs: itemTs,
            updatedTs: itemTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate: '2025-06-09', googleEventId: 'inst-noop', type: 'modified', title: 'Standup', newTimeStart, newTimeEnd },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const itemOps = await operationsDAO.findArray({ entityId: 'item-noop-ex', entityType: 'item' });
        expect(itemOps).toHaveLength(0);
        // updatedTs untouched — the item was not rewritten.
        const unchanged = await itemsDAO.findByOwnerAndId('item-noop-ex', userId);
        expect(unchanged?.updatedTs).toBe(itemTs);
    });

    it('re-asserts master attendees on an exception-date item when the exception omits them (RFC 5545 inheritance)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Regression: buildModifiedException omits attendees when the instance list equals the
        // master's. The old apply path $unset any GCal-owned key absent on the exception and relied
        // on a re-mirror that never ran — permanently stripping participants from every
        // exception-date item. The fix must restore the master values on such an item.
        const masterAttendees: GCalAttendee[] = [
            { email: 'alice@example.com', responseStatus: 'accepted' },
            { email: 'bob@example.com', responseStatus: 'needsAction' },
        ];
        const date = dayjs().add(7, 'day').format('YYYY-MM-DD');
        const newTimeStart = `${date}T10:15:00`;
        const newTimeEnd = `${date}T10:30:00`;
        const routine = makeRoutine(userId, {
            calendarEventId: 'gcal-evt-inherit',
            calendarIntegrationId: 'int-1',
            attendees: masterAttendees,
            organizer: { email: 'alice@example.com' },
            routineExceptions: [{ date, type: 'modified', newTimeStart, newTimeEnd }],
        });
        await routinesDAO.insertOne(routine);

        // Item already stripped by the pre-fix behavior: no attendees/organizer despite the master carrying them.
        await itemsDAO.insertOne({
            _id: 'item-stripped',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            calendarInstanceEventId: 'inst-stripped',
            timeStart: newTimeStart,
            timeEnd: newTimeEnd,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate: date, googleEventId: 'inst-stripped', type: 'modified', title: 'Standup', newTimeStart, newTimeEnd },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const healed = await itemsDAO.findByOwnerAndId('item-stripped', userId);
        expect(healed?.attendees).toEqual(masterAttendees);
        expect(healed?.organizer).toEqual({ email: 'alice@example.com' });
        // The heal is a real change and must be recorded as an op so other devices converge.
        const itemOps = await operationsDAO.findArray({ entityId: 'item-stripped', entityType: 'item' });
        expect(itemOps).toHaveLength(1);
    });

    it('keeps a per-instance attendee override winning over the master list', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const masterAttendees: GCalAttendee[] = [{ email: 'alice@example.com', responseStatus: 'accepted' }];
        const overrideAttendees: GCalAttendee[] = [
            { email: 'alice@example.com', responseStatus: 'accepted' },
            { email: 'guest@example.com', responseStatus: 'tentative' },
        ];
        const date = dayjs().add(7, 'day').format('YYYY-MM-DD');
        const routine = makeRoutine(userId, {
            calendarEventId: 'gcal-evt-override',
            calendarIntegrationId: 'int-1',
            attendees: masterAttendees,
            routineExceptions: [{ date, type: 'modified', attendees: overrideAttendees }],
        });
        await routinesDAO.insertOne(routine);

        await itemsDAO.insertOne({
            _id: 'item-override',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            calendarInstanceEventId: 'inst-override',
            timeStart: `${date}T09:00:00`,
            timeEnd: `${date}T09:30:00`,
            attendees: masterAttendees,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate: date, googleEventId: 'inst-override', type: 'modified', title: 'Standup', attendees: overrideAttendees },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updated = await itemsDAO.findByOwnerAndId('item-override', userId);
        expect(updated?.attendees).toEqual(overrideAttendees);
    });

    it('unsets GCal-owned keys carried by neither the exception nor the master', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // "GCal removed all attendees" case: master no longer mirrors any attendees and the
        // exception reports none either — a stale mirrored list on the item must be cleared,
        // not resurrected by the inheritance merge.
        const date = dayjs().add(7, 'day').format('YYYY-MM-DD');
        const newTimeStart = `${date}T11:00:00`;
        const routine = makeRoutine(userId, {
            calendarEventId: 'gcal-evt-clear',
            calendarIntegrationId: 'int-1',
            routineExceptions: [{ date, type: 'modified', newTimeStart }],
        });
        await routinesDAO.insertOne(routine);

        await itemsDAO.insertOne({
            _id: 'item-stale-att',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            calendarInstanceEventId: 'inst-stale-att',
            timeStart: `${date}T09:00:00`,
            timeEnd: `${date}T09:30:00`,
            attendees: [{ email: 'ghost@example.com', responseStatus: 'declined' }],
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate: date, googleEventId: 'inst-stale-att', type: 'modified', title: 'Standup', newTimeStart },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const cleared = await itemsDAO.findByOwnerAndId('item-stale-att', userId);
        expect(cleared?.attendees).toBeUndefined();
    });

    it('does not overwrite a per-instance RSVP responseStatus with the master series response', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // buildModifiedException NEVER emits responseStatus, so a naive master∪override merge resolves
        // it to the series value on every sync — silently replacing the user's own per-instance RSVP
        // (the one local-write exception to GCal ownership) with data contradicting the attendees array.
        const date = dayjs().add(7, 'day').format('YYYY-MM-DD');
        const masterAttendees: GCalAttendee[] = [{ email: 'me@example.com', responseStatus: 'needsAction', self: true }];
        const myRsvpAttendees: GCalAttendee[] = [{ email: 'me@example.com', responseStatus: 'declined', self: true }];
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-rsvp',
                calendarIntegrationId: 'int-1',
                attendees: masterAttendees,
                responseStatus: 'needsAction',
            }),
        );
        await itemsDAO.insertOne({
            _id: 'item-rsvped',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            calendarInstanceEventId: 'inst-rsvped',
            timeStart: `${date}T09:00:00`,
            timeEnd: `${date}T09:30:00`,
            attendees: myRsvpAttendees,
            responseStatus: 'declined',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        // The forked instance reports the diverged attendee list but carries no responseStatus.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate: date, googleEventId: 'inst-rsvped', type: 'modified', attendees: myRsvpAttendees },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const after = await itemsDAO.findByOwnerAndId('item-rsvped', userId);
        // The denorm must agree with the attendees array in the same document.
        expect(after?.responseStatus).toBe('declined');
        expect(after?.attendees).toEqual(myRsvpAttendees);
    });

    it('restores master GCal-owned fields when reverting an item to master time', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Reconcile-away path: GCal stopped reporting the instance as overridden (user dragged it back
        // to its master time), so the local exception is dropped and the item reverts. The revert must
        // positively RE-ASSERT the master's GCal-owned values — the previous implementation relied on
        // unset-everything plus a re-mirror that never ran, leaving the item bare.
        const masterAttendees: GCalAttendee[] = [
            { email: 'alice@example.com', responseStatus: 'accepted' },
            { email: 'bob@example.com', responseStatus: 'needsAction' },
        ];
        const date = dayjs().add(7, 'day').format('YYYY-MM-DD');
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-revert',
                calendarIntegrationId: 'int-1',
                attendees: masterAttendees,
                organizer: { email: 'alice@example.com' },
                location: 'Room 4',
                // Pure-time move ⇒ isReconcilable, and the date is inside the reconcile window.
                routineExceptions: [{ date, type: 'modified', newTimeStart: `${date}T14:00:00`, newTimeEnd: `${date}T14:30:00` }],
            }),
        );
        // Item sits at the MOVED time and has been stripped of master values by the old behavior.
        await itemsDAO.insertOne({
            _id: 'item-reverting',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            calendarInstanceEventId: 'inst-reverting',
            timeStart: `${date}T14:00:00`,
            timeEnd: `${date}T14:30:00`,
            location: 'Stale Room 9',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        // GCal no longer reports the override ⇒ reconcileRemovedExceptions reverts + drops it.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const reverted = await itemsDAO.findByOwnerAndId('item-reverting', userId);
        // masterTimes must win over the patch's sharedFields — the item returns to the 09:00 template time.
        expect(reverted?.timeStart).toBe(`${date}T09:00:00`);
        // …and the master's GCal-owned slice is re-asserted rather than left bare.
        expect(reverted?.attendees).toEqual(masterAttendees);
        expect(reverted?.organizer).toEqual({ email: 'alice@example.com' });
        expect(reverted?.location).toBe('Room 4');
        // The reconciled-away exception is gone from the routine.
        const routineAfter = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(routineAfter?.routineExceptions ?? []).toHaveLength(0);
    });

    it('reverts a modified-instance item to master time and drops the exception when GCal stops reporting it', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Repro of the "nudged then moved back, app stuck at the old time" bug: the user moved an
        // instance (12:00 → 11:45, recorded as a modified exception), then dragged it back to master
        // time. GCal drops the override, so getExceptions no longer reports this date. The stale
        // exception + moved item must be reconciled away.
        const date = dayjs().add(14, 'day').format('YYYY-MM-DD'); // in-window (within now+1y)
        const movedStart = `${date}T11:45:00`;
        const movedEnd = `${date}T12:45:00`;
        // makeRoutine's template is 09:00 / 30min, so master time for `date` is 09:00–09:30.
        const masterStart = `${date}T09:00:00`;
        const masterEnd = `${date}T09:30:00`;
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-revert',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                routineExceptions: [{ date, type: 'modified', newTimeStart: movedStart, newTimeEnd: movedEnd }],
            }),
        );
        const itemTs = '2026-01-01T00:00:00.000Z';
        await itemsDAO.insertOne({
            _id: 'item-revert',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: movedStart,
            timeEnd: movedEnd,
            createdTs: itemTs,
            updatedTs: itemTs,
        });

        // GCal reports NO exceptions for this series — the instance is back at master time.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-revert' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Item reverted to master time.
        const item = await itemsDAO.findByOwnerAndId('item-revert', userId);
        expect(item?.timeStart).toBe(masterStart);
        expect(item?.timeEnd).toBe(masterEnd);
        // Stale exception removed from the routine.
        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions ?? []).not.toContainEqual(expect.objectContaining({ date, type: 'modified' }));
    });

    it('does NOT reconcile away a modified exception outside the getExceptions window (older than 30 days)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // An exception 60 days in the past is never reported by getExceptions (timeMin floor is now-30d),
        // so its absence must NOT be treated as "removed" — that would wrongly drop a still-valid override.
        const oldDate = dayjs().subtract(60, 'day').format('YYYY-MM-DD');
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-oldex',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                routineExceptions: [{ date: oldDate, type: 'modified', newTimeStart: `${oldDate}T11:45:00`, newTimeEnd: `${oldDate}T12:45:00` }],
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-oldex' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions).toContainEqual(expect.objectContaining({ date: oldDate, type: 'modified' }));
    });

    it('does NOT reconcile away a time-move exception dated before the sync cursor (within now-30d but predating lastSyncedTs)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // Recent cursor: getExceptions' real timeMin is max(since, now-30d) = since. An exception dated
        // 10 days ago is inside [now-30d, now] but BEFORE the cursor, so GCal never returns it — its
        // absence must NOT be treated as "removed". Pre-fix (hardcoded now-30d window) this was a
        // silent data-loss revert.
        const integration = makeIntegration(userId);
        await calendarIntegrationsDAO.insertEncrypted(integration);
        const recentCursor = dayjs().subtract(5, 'day').toISOString();
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(userId, integration._id, { lastSyncedTs: recentCursor }));

        const preCursorDate = dayjs().subtract(10, 'day').format('YYYY-MM-DD');
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-precursor',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                routineExceptions: [
                    { date: preCursorDate, type: 'modified', newTimeStart: `${preCursorDate}T11:45:00`, newTimeEnd: `${preCursorDate}T12:45:00` },
                ],
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-precursor' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions).toContainEqual(expect.objectContaining({ date: preCursorDate, type: 'modified' }));
    });

    it('does NOT reconcile away a time-move exception ON the cursor date (same-day boundary, master time before cursor instant)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // Same-day sliver: cursor instant is 14:30 on its date; the master instance time is 09:00, so
        // GCal's timeMin (full ISO) excludes this instance even though its date == the cursor's date.
        // A date-only window would wrongly include it → revert. The strict floor (date > floorDate)
        // must drop the cursor's own date so this exception is preserved.
        const integration = makeIntegration(userId);
        await calendarIntegrationsDAO.insertEncrypted(integration);
        const sinceDate = dayjs().subtract(3, 'day').format('YYYY-MM-DD');
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(userId, integration._id, { lastSyncedTs: `${sinceDate}T14:30:00.000Z` }));

        // Exception on the cursor's own date; master template time is 09:00 (< 14:30 cursor).
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-sameday',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                routineExceptions: [{ date: sinceDate, type: 'modified', newTimeStart: `${sinceDate}T11:45:00`, newTimeEnd: `${sinceDate}T12:45:00` }],
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-sameday' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions).toContainEqual(expect.objectContaining({ date: sinceDate, type: 'modified' }));
    });

    it('does NOT reconcile away a time-move exception ON the now+1y ceiling date (symmetric boundary)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Symmetric to the floor sliver: getExceptions' timeMax is the now+1y INSTANT. An exception on
        // the now+1y calendar date but later-in-day than `now` is excluded by the provider, so its
        // absence must not trigger a revert. The strict ceiling (date < windowEnd) drops that day.
        const ceilingDate = dayjs().add(1, 'year').format('YYYY-MM-DD');
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-ceiling',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                routineExceptions: [{ date: ceilingDate, type: 'modified', newTimeStart: `${ceilingDate}T11:45:00`, newTimeEnd: `${ceilingDate}T12:45:00` }],
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-ceiling' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions).toContainEqual(expect.objectContaining({ date: ceilingDate, type: 'modified' }));
    });

    // ─── skipped-exception revival (un-deleted / restored GCal instances) ─────
    //
    // Symmetric sibling of the time-move reconcile tests above. makeRoutine's rrule is
    // FREQ=WEEKLY;BYDAY=MO anchored at createdTs (now), so revival dates must be a Monday ON/AFTER
    // the anchor week for `routineGeneratesOccurrenceOnDate` to confirm the occurrence is real.

    /** The Nth future Monday from today (N=1 → the next upcoming Monday), as YYYY-MM-DD. */
    function futureMonday(weeksAhead: number): string {
        const today = dayjs().startOf('day');
        const daysUntilMonday = (8 - today.day()) % 7 || 7; // 1..7, never 0 → always strictly future
        return today
            .add(daysUntilMonday, 'day')
            .add((weeksAhead - 1) * 7, 'day')
            .format('YYYY-MM-DD');
    }

    it('revives a trashed routine item to master time and drops the skipped exception when GCal stops reporting the deletion', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // The user deleted a routine occurrence on GCal (→ local `skipped` exception + trashed item),
        // then un-deleted it. GCal no longer reports the date as `deleted`, so the occurrence is back:
        // the trashed item must return to `status:'calendar'` at master time + the exception drop.
        const date = futureMonday(2);
        // makeRoutine's template is 09:00 / 30min → master time for `date` is 09:00–09:30.
        const masterStart = `${date}T09:00:00`;
        const masterEnd = `${date}T09:30:00`;
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-revive',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                routineExceptions: [{ date, type: 'skipped' }],
            }),
        );
        const itemTs = '2026-01-01T00:00:00.000Z';
        await itemsDAO.insertOne({
            _id: 'item-revive',
            user: userId,
            status: 'trash',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: masterStart,
            timeEnd: masterEnd,
            cancelledByGCal: true,
            createdTs: itemTs,
            updatedTs: itemTs,
        });

        // GCal reports NO exceptions — the cancellation tombstone is gone.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-revive' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findByOwnerAndId('item-revive', userId);
        expect(item?.status).toBe('calendar');
        expect(item?.timeStart).toBe(masterStart);
        expect(item?.timeEnd).toBe(masterEnd);
        // cancelledByGCal badge cleared on revive.
        expect(item?.cancelledByGCal).toBeUndefined();
        // Instance id re-minted so the row re-occupies the unique partial index.
        expect(item?.calendarInstanceEventId).toBeTruthy();
        // skipped exception dropped from the routine.
        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions ?? []).not.toContainEqual(expect.objectContaining({ date, type: 'skipped' }));
    });

    it('revives an ALL-DAY routine occurrence to the single-day master range with a YYYYMMDD instance id', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // All-day template path: revival must produce a date-only single-day range (GCal exclusive-end
        // → +1 day), set allDay:true, and mint the YYYYMMDD (no T) instance-id form. The all-day branch
        // in buildRevivedInstanceEventId + reviveTrashedRoutineItemInPlace was otherwise untested.
        const date = futureMonday(2);
        const nextDay = dayjs(date).add(1, 'day').format('YYYY-MM-DD');
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-allday',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                calendarItemTemplate: { allDay: true },
                routineExceptions: [{ date, type: 'skipped' }],
            }),
        );
        await itemsDAO.insertOne({
            _id: 'item-allday-revive',
            user: userId,
            status: 'trash',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: date,
            timeEnd: nextDay,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-allday' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findByOwnerAndId('item-allday-revive', userId);
        expect(item?.status).toBe('calendar');
        expect(item?.allDay).toBe(true);
        expect(item?.timeStart).toBe(date);
        expect(item?.timeEnd).toBe(nextDay);
        // All-day instance id is YYYYMMDD only (no T component).
        expect(item?.calendarInstanceEventId).toBe(`gcal-evt-allday_${date.replace(/-/g, '')}`);
    });

    it('revives via orphan-create when no trashed row survives at the master date', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // The trashed row was purged (or its timeStart shifted off the master date by a prior move), so
        // the in-place lookup misses → reviveSkippedOccurrence falls back to createItemForOrphanedException,
        // which mints a fresh master-time row. Exercises the `!target` branch.
        const date = futureMonday(2);
        const masterStart = `${date}T09:00:00`;
        const masterEnd = `${date}T09:30:00`;
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-orphanrevive',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                routineExceptions: [{ date, type: 'skipped' }],
            }),
        );
        // Deliberately NO trashed item at the master date.

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-orphanrevive' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // A fresh live calendar item was created at master time, with the re-minted instance id.
        const created = await itemsDAO.findArray({ user: userId, routineId: 'routine-1', status: 'calendar' });
        expect(created).toHaveLength(1);
        const [item] = created;
        if (!item) throw new Error('expected one orphan-created item');
        expect(item.timeStart).toBe(masterStart);
        expect(item.timeEnd).toBe(masterEnd);
        expect(item.calendarInstanceEventId).toBeTruthy();
        // skipped exception dropped.
        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions ?? []).not.toContainEqual(expect.objectContaining({ date, type: 'skipped' }));
    });

    // ─── moved instance landing on a cancelled occurrence's date (the "ALL HANDS" flip-flop) ─────

    it('keeps a moved instance that landed on a cancelled occurrence date stable across syncs (no create/trash flip-flop)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Staging incident: GCal moved the Sept 1 occurrence to Sept 8 15:00 AND cancelled the regular
        // Sept 8 occurrence. The cancelled exception missed tier 1 (no row carries the Sept 8 id) and
        // the tier-2 date fallback grabbed the moved Sept 1 row now sitting on Sept 8 → trashed it; the
        // next sync found no live row for the Sept 1 exception → re-created it as an orphan. Every
        // sync produced create/update/trash ops (~1,600 dead rows, a push notification per cycle).
        const movedFrom = futureMonday(2);
        const cancelled = futureMonday(3);
        const movedInstanceId = `gcal-evt-allhands_${movedFrom.replace(/-/g, '')}T060000Z`;
        const cancelledInstanceId = `gcal-evt-allhands_${cancelled.replace(/-/g, '')}T060000Z`;
        const selfAttendees: GCalAttendee[] = [
            { email: 'organizer@example.com', responseStatus: 'accepted', organizer: true },
            { email: 'alice@example.com', responseStatus: 'needsAction', self: true },
        ];
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                title: 'ALL HANDS',
                calendarEventId: 'gcal-evt-allhands',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                attendees: [
                    { email: 'organizer@example.com', responseStatus: 'accepted', organizer: true },
                    { email: 'alice@example.com', responseStatus: 'accepted', self: true },
                ],
                responseStatus: 'accepted',
            }),
        );
        // Re-syncs carry the syncToken from the first run and take the incremental fetch path.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue({ events: [], nextSyncToken: 'tok-allhands' });
        // getExceptions is a time-range query — both exceptions are re-reported on EVERY sync.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate: movedFrom,
                type: 'modified',
                newTimeStart: `${cancelled}T15:00:00+03:00`,
                newTimeEnd: `${cancelled}T15:30:00+03:00`,
                googleEventId: movedInstanceId,
                attendees: selfAttendees,
            },
            { originalDate: cancelled, type: 'deleted', googleEventId: cancelledInstanceId },
        ]);

        const syncAndReadBack = async () => {
            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            const rows = await itemsDAO.findArray({ user: userId, routineId: 'routine-1' });
            const itemOps = await operationsDAO.findArray({ user: userId, entityType: 'item' });
            return { live: rows.filter((row) => row.status === 'calendar'), trashed: rows.filter((row) => row.status === 'trash'), itemOps };
        };

        const first = await syncAndReadBack();
        expect(first.live).toHaveLength(1);
        expect(first.trashed).toHaveLength(0);
        const [created] = first.live;
        if (!created) throw new Error('expected one orphan-created item');
        expect(created.calendarInstanceEventId).toBe(movedInstanceId);
        expect(created.timeStart).toBe(`${cancelled}T15:00:00+03:00`);
        // The orphan-create path derives responseStatus from the instance's own self attendee (the
        // modified-exception apply rule), NOT the series value — otherwise the next apply is a
        // guaranteed redundant update op.
        expect(created.responseStatus).toBe('needsAction');
        expect(first.itemOps.map((op) => op.opType)).toEqual(['create']);

        // Re-syncs are fully idempotent: same single live row, nothing trashed, no new item ops.
        const second = await syncAndReadBack();
        const third = await syncAndReadBack();
        for (const run of [second, third]) {
            expect(run.live.map((row) => row._id)).toEqual([created._id]);
            expect(run.trashed).toHaveLength(0);
            expect(run.itemOps).toHaveLength(1);
        }
    });

    it('date-matches only the legacy row (no instance id) on a date shared with a row anchored to another occurrence', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Two live rows on the cancelled date: a legacy row (pre instance-id rollout, no id) that IS this
        // occurrence and must still resolve by date, and a row carrying a DIFFERENT instance id (another
        // occurrence GCal moved onto this date) that must be left alone. Dropping or inverting the
        // tier-2 exclusion fails this either way.
        const date = futureMonday(2);
        const movedFrom = futureMonday(1);
        await routinesDAO.insertOne(
            makeRoutine(userId, { calendarEventId: 'gcal-evt-legacy', calendarIntegrationId: 'int-1', calendarSyncConfigId: 'sync-config-1' }),
        );
        const rowOnDate = (id: string, timeOfDay: string, instanceEventId?: string): ItemInterface => ({
            _id: id,
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: `${date}T${timeOfDay}:00`,
            timeEnd: `${date}T${timeOfDay}:00`,
            ...(instanceEventId ? { calendarInstanceEventId: instanceEventId } : {}),
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });
        await itemsDAO.insertOne(rowOnDate('item-legacy', '09:00'));
        await itemsDAO.insertOne(rowOnDate('item-moved-here', '15:00', `gcal-evt-legacy_${movedFrom.replace(/-/g, '')}T060000Z`));
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate: date, type: 'deleted', googleEventId: `gcal-evt-legacy_${date.replace(/-/g, '')}T060000Z` },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        expect((await itemsDAO.findByOwnerAndId('item-legacy', userId))?.status).toBe('trash');
        expect((await itemsDAO.findByOwnerAndId('item-moved-here', userId))?.status).toBe('calendar');
    });

    it('stamps inbound timestamps when the calendar lock is acquired, not at request arrival', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // A manual sync queued behind the per-calendar lock used to carry `now` from request arrival
        // (observed ~85 min stale on staging under a client-driven sync storm), so every row it wrote
        // got a backdated createdTs/updatedTs and lost LWW against real edits.
        const date = futureMonday(2);
        await routinesDAO.insertOne(
            makeRoutine(userId, { calendarEventId: 'gcal-evt-stamp', calendarIntegrationId: 'int-1', calendarSyncConfigId: 'sync-config-1' }),
        );
        const lockReleasedAt: string[] = [];
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue({ events: [], nextSyncToken: 'tok-stamp' });
        const getExceptions = vi
            .spyOn(GoogleCalendarProvider.prototype, 'getExceptions')
            // First sync: hold the lock for a while, then note when it is about to be released.
            .mockImplementationOnce(async () => {
                await new Promise((resolve) => setTimeout(resolve, 300));
                lockReleasedAt.push(dayjs().toISOString());
                return [];
            })
            // Second sync (queued behind the first): orphan-creates a row whose stamps we inspect.
            .mockResolvedValueOnce([
                {
                    originalDate: date,
                    type: 'modified',
                    newTimeStart: `${date}T10:00:00+03:00`,
                    newTimeEnd: `${date}T10:30:00+03:00`,
                    googleEventId: `gcal-evt-stamp_${date.replace(/-/g, '')}T060000Z`,
                },
            ]);

        const firstSync = authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        // Only fire the second request once the first provably holds the lock (it is inside getExceptions).
        await vi.waitFor(() => expect(getExceptions).toHaveBeenCalledTimes(1));
        const secondSync = authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        const [firstRes, secondRes] = await Promise.all([firstSync, secondSync]);
        expect(firstRes.status).toBe(200);
        expect(secondRes.status).toBe(200);

        const [releasedAt] = lockReleasedAt;
        if (!releasedAt) throw new Error('expected the first sync to record its lock release');
        const created = await itemsDAO.findArray({ user: userId, routineId: 'routine-1', status: 'calendar' });
        expect(created).toHaveLength(1);
        const [item] = created;
        if (!item) throw new Error('expected one orphan-created item');
        expect(item.createdTs >= releasedAt).toBe(true);
        expect(item.updatedTs).toBe(item.createdTs);
        const [createOp] = await operationsDAO.findArray({ user: userId, entityType: 'item', entityId: item._id });
        if (!createOp) throw new Error('expected a create op for the orphan-created item');
        expect(createOp.ts >= releasedAt).toBe(true);
    });

    it('does NOT revive a skipped exception when the master rrule no longer generates that occurrence', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // A skipped date can vanish from getExceptions because the master recurrence changed (e.g. the
        // routine was paused → capped with UNTIL) so the occurrence no longer exists — reviving it would
        // resurrect a phantom. Here the routine is weekly-Monday but the exception is on a SUNDAY, which
        // the rrule never generates → the GCal-truth guard must refuse to revive.
        const monday = futureMonday(2);
        const sunday = dayjs(monday).subtract(1, 'day').format('YYYY-MM-DD'); // never an rrule occurrence
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-phantom',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                routineExceptions: [{ date: sunday, type: 'skipped' }],
            }),
        );
        await itemsDAO.insertOne({
            _id: 'item-phantom',
            user: userId,
            status: 'trash',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: `${sunday}T09:00:00`,
            timeEnd: `${sunday}T09:30:00`,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-phantom' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Item stays trashed; skipped exception preserved.
        const item = await itemsDAO.findByOwnerAndId('item-phantom', userId);
        expect(item?.status).toBe('trash');
        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions).toContainEqual(expect.objectContaining({ date: sunday, type: 'skipped' }));
    });

    it('does NOT revive a skipped exception GCal still reports as deleted (occurrence still cancelled)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // GCal still reports the date as `deleted` → the occurrence is still cancelled → no revival.
        const date = futureMonday(2);
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-stillcancelled',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                routineExceptions: [{ date, type: 'skipped' }],
            }),
        );
        await itemsDAO.insertOne({
            _id: 'item-stillcancelled',
            user: userId,
            status: 'trash',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: `${date}T09:00:00`,
            timeEnd: `${date}T09:30:00`,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([{ originalDate: date, type: 'deleted' }]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-stillcancelled' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findByOwnerAndId('item-stillcancelled', userId);
        expect(item?.status).toBe('trash');
        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions).toContainEqual(expect.objectContaining({ date, type: 'skipped' }));
    });

    it('does NOT revive a skipped exception outside the getExceptions window (older than 30 days)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // 60 days in the past: getExceptions' timeMin floor is now-30d, so this date is never reported —
        // its absence from the deleted set must NOT trigger a revival (would resurrect a stale deletion).
        // Pick a past Monday so the rrule-generates guard isn't what blocks it — the window guard must.
        const today = dayjs().startOf('day');
        const daysSinceMonday = (today.day() + 6) % 7; // 0 if Monday
        const recentPastMonday = today.subtract(daysSinceMonday, 'day');
        const oldMonday = recentPastMonday.subtract(9, 'week').format('YYYY-MM-DD'); // ~63 days ago, a Monday
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-oldskip',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                // Anchor startDate well before the old date so the rrule WOULD generate it — isolating the window guard.
                startDate: oldMonday,
                routineExceptions: [{ date: oldMonday, type: 'skipped' }],
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-oldskip' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions).toContainEqual(expect.objectContaining({ date: oldMonday, type: 'skipped' }));
    });

    it('does NOT revive a skipped exception dated before the sync cursor (within now-30d but predating lastSyncedTs)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // Recent cursor: getExceptions' real timeMin is max(since, now-30d) = since. A skipped date 10
        // days ago is inside [now-30d, now] but BEFORE the cursor, so GCal never returns it — its absence
        // must NOT be treated as a revival (mirrors the time-move pre-cursor preserve test).
        const integration = makeIntegration(userId);
        await calendarIntegrationsDAO.insertEncrypted(integration);
        const recentCursor = dayjs().subtract(5, 'day').toISOString();
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(userId, integration._id, { lastSyncedTs: recentCursor }));

        const today = dayjs().startOf('day');
        const daysSinceMonday = (today.day() + 6) % 7;
        const recentPastMonday = today.subtract(daysSinceMonday, 'day');
        const preCursorMonday = recentPastMonday.subtract(1, 'week').format('YYYY-MM-DD'); // a Monday ~7-13 days ago
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-precursorskip',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                startDate: preCursorMonday,
                routineExceptions: [{ date: preCursorMonday, type: 'skipped' }],
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-precursorskip' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions).toContainEqual(expect.objectContaining({ date: preCursorMonday, type: 'skipped' }));
    });

    it('does not re-fire (zero churn) on a sync against already-revived state (no skipped exception left)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Steady state AFTER a revival: the skipped exception was already dropped on a prior sync and the
        // item is already live at master time. A subsequent sync (getExceptions still []) must find no
        // skipped exception to revive → no item write, no routine write, no ops. This is exactly the
        // second-fire condition; we set it up directly to avoid a second real-HTTP sync in the harness.
        const date = futureMonday(2);
        const itemTs = '2026-01-01T00:00:00.000Z';
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-evt-churn',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                routineExceptions: [], // already reconciled away
                updatedTs: itemTs,
            }),
        );
        await itemsDAO.insertOne({
            _id: 'item-churn',
            user: userId,
            status: 'calendar', // already revived
            title: 'Standup',
            routineId: 'routine-1',
            calendarInstanceEventId: 'gcal-evt-churn_inst',
            timeStart: `${date}T09:00:00`,
            timeEnd: `${date}T09:30:00`,
            createdTs: itemTs,
            updatedTs: itemTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-churn' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // No new ops for the item or routine, and neither was rewritten.
        const itemOps = await operationsDAO.findArray({ user: userId, entityType: 'item', entityId: 'item-churn' });
        expect(itemOps).toHaveLength(0);
        const routineOps = await operationsDAO.findArray({ user: userId, entityType: 'routine', entityId: 'routine-1' });
        expect(routineOps).toHaveLength(0);
        const item = await itemsDAO.findByOwnerAndId('item-churn', userId);
        expect(item?.updatedTs).toBe(itemTs);
        const routine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(routine?.updatedTs).toBe(itemTs);
    });

    it('skips the routine master write + op when an unchanged GCal event re-syncs (no-op churn guard)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Steady state: the GCal master is untouched, so `event.updated` equals the routine's stored
        // `lastSyncedFromGCalTs`. `structurallyNewer` uses `>=` (GCal wins same-second ties), so this
        // still passes the structural-newer gate and falls through to the master merge — but the merged
        // routine is byte-identical to what's stored, so no routine write and no `update` op should fire.
        const gcalUpdated = '2026-01-01T00:00:00.000Z';
        // 09:00 Jerusalem (UTC+3 in June) / 30-minute duration → matches makeRoutine's default template.
        const masterTimeStart = '2025-06-09T09:00:00+03:00';
        const masterTimeEnd = '2025-06-09T09:30:00+03:00';
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                calendarEventId: 'gcal-master-noop',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                lastSyncedFromGCalTs: gcalUpdated,
                updatedTs: '2026-02-01T00:00:00.000Z',
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-master-noop',
                    title: 'Standup',
                    timeStart: masterTimeStart,
                    timeEnd: masterTimeEnd,
                    updated: gcalUpdated,
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-master-noop',
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routineOps = await operationsDAO.findArray({ entityId: 'routine-1', entityType: 'routine' });
        expect(routineOps).toHaveLength(0);
        // updatedTs untouched — the routine was not rewritten.
        const unchanged = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(unchanged?.updatedTs).toBe('2026-02-01T00:00:00.000Z');
    });

    it('still writes the item when only notes change but times are unchanged (no-op guard lets real changes through)', async () => {
        // Positive-direction guard check: same times as the item already holds, but a new notes value.
        // The per-field comparison in isItemUpdateNoop must report "changed" so the write proceeds.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const timeStart = '2025-06-09T09:00:00Z';
        const timeEnd = '2025-06-09T09:30:00Z';
        await routinesDAO.insertOne(makeRoutine(userId, { calendarEventId: 'gcal-evt-notesonly', calendarIntegrationId: 'int-1' }));
        await itemsDAO.insertOne({
            _id: 'item-notes-change',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            notes: 'old agenda',
            routineId: 'routine-1',
            calendarInstanceEventId: 'inst-notes',
            timeStart,
            timeEnd,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            {
                originalDate: '2025-06-09',
                googleEventId: 'inst-notes',
                type: 'modified',
                title: 'Standup',
                notes: '<p>new agenda</p>',
                newTimeStart: timeStart,
                newTimeEnd: timeEnd,
            },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findByOwnerAndId('item-notes-change', userId);
        expect(item?.notes).toBe('new agenda');
        const itemOps = await operationsDAO.findArray({ entityId: 'item-notes-change', entityType: 'item' });
        expect(itemOps.length).toBeGreaterThan(0);
    });

    it('still writes the item when a modified exception drops a GCal-owned override the item carried (unset branch)', async () => {
        // Unset-branch guard check: the item carries an `attendees` override; the inbound exception omits
        // it (instance reverted to master inheritance), so unsetFields is non-empty. isItemUpdateNoop must
        // return false on any pending unset so the clearing write proceeds.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const timeStart = '2025-06-09T09:00:00Z';
        const timeEnd = '2025-06-09T09:30:00Z';
        await routinesDAO.insertOne(makeRoutine(userId, { calendarEventId: 'gcal-evt-unset', calendarIntegrationId: 'int-1' }));
        await itemsDAO.insertOne({
            _id: 'item-unset-attendees',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            calendarInstanceEventId: 'inst-unset',
            attendees: [{ email: 'extra@example.com', responseStatus: 'accepted' }],
            timeStart,
            timeEnd,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });

        // Exception omits `attendees` ⇒ instance inherits master ⇒ the override must be unset on the item.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate: '2025-06-09', googleEventId: 'inst-unset', type: 'modified', title: 'Standup', newTimeStart: timeStart, newTimeEnd: timeEnd },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findByOwnerAndId('item-unset-attendees', userId);
        expect(item?.attendees).toBeUndefined();
        const itemOps = await operationsDAO.findArray({ entityId: 'item-unset-attendees', entityType: 'item' });
        expect(itemOps.length).toBeGreaterThan(0);
    });

    it('merges a modified exception and updates item times', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const routine = makeRoutine(userId, { calendarEventId: 'gcal-evt-1', calendarIntegrationId: 'int-1' });
        await routinesDAO.insertOne(routine);

        const newTimeStart = '2025-06-09T10:00:00Z';
        const newTimeEnd = '2025-06-09T10:30:00Z';
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate: '2025-06-09', type: 'modified', newTimeStart, newTimeEnd },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updated = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updated?.routineExceptions).toContainEqual({
            date: '2025-06-09',
            type: 'modified',
            newTimeStart,
            newTimeEnd,
        });
    });

    it('merges a content-modified exception and updates item title and notes', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const routine = makeRoutine(userId, { calendarEventId: 'gcal-evt-1', calendarIntegrationId: 'int-1' });
        await routinesDAO.insertOne(routine);

        // Insert an item for the occurrence date that will be content-modified
        await itemsDAO.insertOne({
            _id: 'item-content-ex',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: '2025-06-09T09:00:00Z',
            timeEnd: '2025-06-09T09:30:00Z',
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([
            { originalDate: '2025-06-09', type: 'modified', title: 'Retro', notes: '<p>Agenda: review Q2</p>' },
        ]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Verify the routine exception record stores markdown-converted notes
        const updatedRoutine = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updatedRoutine?.routineExceptions).toContainEqual(
            expect.objectContaining({ date: '2025-06-09', type: 'modified', title: 'Retro', notes: 'Agenda: review Q2' }),
        );

        // Verify the item was updated with converted notes and lastSyncedNotes
        const item = await itemsDAO.findByOwnerAndId('item-content-ex', userId);
        expect(item?.title).toBe('Retro');
        expect(item?.notes).toBe('Agenda: review Q2');
        expect(item?.lastSyncedNotes).toBe('<p>Agenda: review Q2</p>');
    });

    it('preserves a user-typed ✓ in the GCal title when the local routine-generated item is open (not done)', async () => {
        // Symmetric to updateExistingCalendarItem's "open item keeps user-typed ✓" rule: the strip
        // is GCal-marker-aware only when the local item is already done; for an open item, the ✓
        // is treated as user content and must round-trip verbatim.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const routine = makeRoutine(userId, { calendarEventId: 'gcal-evt-1', calendarIntegrationId: 'int-1' });
        await routinesDAO.insertOne(routine);

        await itemsDAO.insertOne({
            _id: 'item-user-checkmark',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: '2025-06-09T09:00:00Z',
            timeEnd: '2025-06-09T09:30:00Z',
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([{ originalDate: '2025-06-09', type: 'modified', title: '✓ Standup' }]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findByOwnerAndId('item-user-checkmark', userId);
        // Open item — the ✓ is user content, not our marker. Round-trip verbatim.
        expect(item?.title).toBe('✓ Standup');
        expect(item?.status).toBe('calendar');
    });

    it('strips the ✓ done marker on inbound modified-exception when the local item is already done', async () => {
        // Echo path: our own pushback applies "✓ Standup" + sage to the GCal instance for a done
        // routine-generated item. The next inbound sync sees that as a `modified` exception with
        // title="✓ Standup". Without stripping, the local item's clean stored title would be
        // overwritten with the marker. The marker must be GCal-only — symmetric to the strip in
        // updateExistingCalendarItem for non-routine calendar items.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const routine = makeRoutine(userId, { calendarEventId: 'gcal-evt-1', calendarIntegrationId: 'int-1' });
        await routinesDAO.insertOne(routine);

        await itemsDAO.insertOne({
            _id: 'item-done-echo',
            user: userId,
            status: 'done',
            title: 'Standup',
            routineId: 'routine-1',
            timeStart: '2025-06-09T09:00:00Z',
            timeEnd: '2025-06-09T09:30:00Z',
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([{ originalDate: '2025-06-09', type: 'modified', title: '✓ Standup' }]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findByOwnerAndId('item-done-echo', userId);
        // Stored title stays clean; the ✓ marker remains on the GCal side only.
        expect(item?.title).toBe('Standup');
        expect(item?.status).toBe('done');
    });

    it('does not generate spurious exceptions when instance matches master content', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const routine = makeRoutine(userId, {
            calendarEventId: 'gcal-evt-1',
            calendarIntegrationId: 'int-1',
            title: 'Standup',
            lastSyncedNotes: '<p>Daily standup</p>',
            template: { notes: 'Daily standup' },
        });
        await routinesDAO.insertOne(routine);

        // getExceptions returns [] because instance matches master — no changes
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updated = await routinesDAO.findByOwnerAndId('routine-1', userId);
        expect(updated?.routineExceptions).toBeUndefined();
    });

    it('imports a new GCal event as a calendar item', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const eventTs = dayjs().add(1, 'day').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-abc', title: 'Team lunch', timeStart: eventTs, timeEnd: eventTs, updated: eventTs, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const items = await db.collection('items').find({ user: userId, calendarEventId: 'evt-abc' }).toArray();
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ status: 'calendar', title: 'Team lunch', calendarIntegrationId: 'int-1', lastSyncedFromGCalTs: eventTs });
    });

    it('manual sync notifies SSE when ops are produced so the calling client knows to pull', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Spy must be installed before the route runs — the SSE notify happens inline.
        const notifySpy = vi.spyOn(sseConnections, 'notifyUserViaSse');

        const eventTs = dayjs().add(1, 'day').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-notify', title: 'After connect', timeStart: eventTs, timeEnd: eventTs, updated: eventTs, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Without this notify, a freshly-connected calendar's events would be created server-side
        // but stay invisible on the originating client until the next webhook arrived.
        expect(notifySpy).toHaveBeenCalledWith(userId, expect.objectContaining({ type: 'update' }));
    });

    it('manual sync skips SSE notify when no ops were produced (avoid spurious pulls)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const notifySpy = vi.spyOn(sseConnections, 'notifyUserViaSse');

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        expect(notifySpy).not.toHaveBeenCalled();
    });

    // ── Outbound backfill: app-created entities pushed to GCal on "Sync now" ────────────
    //
    // Repairs the scenario where a user creates calendar items / routines BEFORE connecting
    // their Google Calendar (or while offline). Without this, those entities stay locally-only
    // forever — no automatic mechanism would push them up. After connecting + clicking
    // "Sync now," they should land on Google Calendar.

    /** Inserts an unlinked calendar item (no calendarEventId, no routineId). */
    async function insertUnlinkedItem(userId: string, overrides: Partial<ItemInterface> = {}): Promise<ItemInterface> {
        const now = dayjs().toISOString();
        const item: ItemInterface = {
            _id: overrides._id ?? 'item-unlinked-1',
            user: userId,
            status: 'calendar',
            title: 'Standalone meeting',
            timeStart: dayjs().add(1, 'day').toISOString(),
            timeEnd: dayjs().add(1, 'day').add(30, 'minute').toISOString(),
            createdTs: now,
            updatedTs: now,
            ...overrides,
        };
        await itemsDAO.insertOne(item);
        return item;
    }

    it('pushes unlinked calendar items to GCal as part of Sync now', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertUnlinkedItem(userId, { _id: 'item-backfill-1', title: 'Backfilled item' });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        const createSpy = vi
            .spyOn(GoogleCalendarProvider.prototype, 'createEvent')
            .mockResolvedValue({ eventId: 'gcal-id-1', htmlLink: 'https://calendar.google.com/calendar/event?eid=backfill-1' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; pushedItems: number };
        expect(body.pushedItems).toBe(1);

        expect(createSpy).toHaveBeenCalledOnce();
        const updated = await itemsDAO.findByOwnerAndId('item-backfill-1', userId);
        expect(updated?.calendarEventId).toBe('gcal-id-1');
        expect(updated?.calendarIntegrationId).toBe('int-1');
        expect(updated?.calendarSyncConfigId).toBe('sync-config-1');
        expect(updated?.lastPushedToGCalTs).toBeTruthy();
        // htmlLink is captured from the insert response in the SAME write as the link fields — the
        // own-echo guard would suppress the inbound webhook report that otherwise carries it.
        expect(updated?.htmlLink).toBe('https://calendar.google.com/calendar/event?eid=backfill-1');
        // An operation must be recorded so other devices learn about the newly-linked event id.
        // Exactly ONE op — stamping htmlLink must not add a second write/echo.
        const recordedOps = await operationsDAO.findArray({ user: userId, entityType: 'item', entityId: 'item-backfill-1' });
        expect(recordedOps).toHaveLength(1);
        expect(recordedOps[0]!.snapshot).toMatchObject({
            calendarEventId: 'gcal-id-1',
            calendarIntegrationId: 'int-1',
            htmlLink: 'https://calendar.google.com/calendar/event?eid=backfill-1',
        });
    });

    it('links the item without htmlLink when the insert response omits it', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertUnlinkedItem(userId, { _id: 'item-backfill-nolink', title: 'No-link item' });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'gcal-id-nolink' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const updated = await itemsDAO.findByOwnerAndId('item-backfill-nolink', userId);
        expect(updated?.calendarEventId).toBe('gcal-id-nolink');
        expect(updated?.htmlLink).toBeUndefined();
    });

    it('pushes unlinked calendar-type routines to GCal as part of Sync now', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // App-side routine creation never stamps calendarIntegrationId — the backfill should add it.
        const routine = makeRoutine(userId, { _id: 'routine-backfill-1', title: 'Backfilled routine' });
        await routinesDAO.insertOne(routine);

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('gcal-recurring-1');

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { pushedRoutines: number };
        expect(body.pushedRoutines).toBe(1);

        expect(createSpy).toHaveBeenCalledOnce();
        const updated = await routinesDAO.findByOwnerAndId('routine-backfill-1', userId);
        expect(updated?.calendarEventId).toBe('gcal-recurring-1');
        expect(updated?.calendarIntegrationId).toBe('int-1');
        expect(updated?.calendarSyncConfigId).toBe('sync-config-1');
    });

    it('skips items that are already linked (calendarEventId set)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertUnlinkedItem(userId, { _id: 'item-already', calendarEventId: 'evt-existing', calendarIntegrationId: 'int-1' });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent');

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { pushedItems: number };
        expect(body.pushedItems).toBe(0);
        expect(createSpy).not.toHaveBeenCalled();
    });

    it('skips routine-generated items (routineId set)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // routineId set → represented by the routine's master event; no individual GCal event.
        await insertUnlinkedItem(userId, { _id: 'item-routine-instance', routineId: 'r-x' });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent');

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { pushedItems: number };
        expect(body.pushedItems).toBe(0);
        expect(createSpy).not.toHaveBeenCalled();
    });

    it('skips inactive routines during backfill', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const routine = makeRoutine(userId, { _id: 'routine-inactive', active: false });
        await routinesDAO.insertOne(routine);

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent');

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { pushedRoutines: number };
        expect(body.pushedRoutines).toBe(0);
        expect(createSpy).not.toHaveBeenCalled();
    });

    it('skips disconnect-kept routines (lastKnownCalendarEventId set) — never pushes them as a gtd* clone', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // A routine unlinked by disconnect-with-keep: no calendarEventId, but a lastKnown* marker awaiting
        // inbound relink. The backfill must NOT push it — doing so mints a gtd* clone master on Google.
        await routinesDAO.insertOne(
            makeRoutine(userId, { _id: 'routine-kept', lastKnownCalendarEventId: 'gcal-master-real', lastKnownCalendarIntegrationId: 'int-OLD' }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent');

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { pushedRoutines: number };
        expect(body.pushedRoutines).toBe(0);
        expect(createSpy).not.toHaveBeenCalled();
    });

    it('skips disconnect-kept calendar items (lastKnownCalendarEventId set) during backfill', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertUnlinkedItem(userId, { _id: 'item-kept', lastKnownCalendarEventId: 'gcal-evt-real', lastKnownCalendarIntegrationId: 'int-OLD' });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent');

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { pushedItems: number };
        expect(body.pushedItems).toBe(0);
        expect(createSpy).not.toHaveBeenCalled();
    });

    it('only backfills onto the default config when multiple configs exist', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // Default config + a non-default config on the same integration. Item should land on the default.
        const { integration } = await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.insertOne(
            makeSyncConfig(userId, integration._id, { _id: 'sync-config-2', calendarId: 'work@group.calendar.google.com', isDefault: false }),
        );
        await insertUnlinkedItem(userId, { _id: 'item-default-only' });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'gcal-default' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Item count == 1 even though 2 configs are synced inbound: backfill only runs against the default.
        expect(createSpy).toHaveBeenCalledOnce();
        // Argument 0 to createEvent is the calendarId — must be the default's, not the non-default's.
        const firstCall = createSpy.mock.calls[0]!;
        expect(firstCall[0]).toBe('primary');
    });

    it('paces backfill calls with sleeps to stay under GCal rate limits', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertUnlinkedItem(userId, { _id: 'item-pace-1', title: 'A' });
        await insertUnlinkedItem(userId, { _id: 'item-pace-2', title: 'B' });
        await insertUnlinkedItem(userId, { _id: 'item-pace-3', title: 'C' });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        let n = 0;
        vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockImplementation(async () => ({ eventId: `gcal-${n++}` }));

        const start = Date.now();
        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        const elapsed = Date.now() - start;
        expect(res.status).toBe(200);
        // Three items → two inter-call sleeps of 150ms → ≥ 300ms minimum total.
        // Use a generous lower bound (250ms) to absorb scheduler jitter without rewarding regressions.
        expect(elapsed).toBeGreaterThanOrEqual(250);
    });

    it('notifies SSE and web push with backfill ops even if there are no inbound events', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertUnlinkedItem(userId, { _id: 'item-sse-backfill' });

        const sseSpy = vi.spyOn(sseConnections, 'notifyUserViaSse');
        const pushSpy = vi.spyOn(webPush, 'notifyViaWebPush').mockResolvedValue();
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        // Inbound is empty — only the backfill produces ops.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });
        vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'gcal-sse' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // SSE refreshes the calling client. Web push reaches devices without an open SSE channel —
        // backfill ops must reach both, otherwise closed-tab devices never learn the items got linked.
        expect(sseSpy).toHaveBeenCalledWith(userId, expect.objectContaining({ type: 'update' }));
        expect(pushSpy).toHaveBeenCalledOnce();
        const opsArg = pushSpy.mock.calls[0]![2];
        expect(opsArg).toHaveLength(1);
        expect(opsArg![0]).toMatchObject({
            entityType: 'item',
            entityId: 'item-sse-backfill',
            opType: 'update',
        });
    });

    it('running Sync now twice does not create duplicate GCal events for unlinked items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertUnlinkedItem(userId, { _id: 'item-idempotent-1' });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        // Both calls go through the inbound pull first. Mock both list paths because the first
        // sync stores a syncToken which makes the second sync take the incremental path.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue({ events: [], nextSyncToken: 'tok-2' });

        // First call: GCal accepts the create (returns the supplied id), but simulate a local DB
        // write failure so the item never gets `calendarEventId`. This is the exact failure mode
        // the deterministic-id design protects against — the next retry must NOT create a second
        // event on Google.
        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockImplementation(async (_calId, _event, _tz, options) => {
            // Echo back the supplied id so we can assert it's deterministic across calls below.
            return { eventId: options?.id ?? 'gcal-fallback' };
        });
        // Force the first updateOne to fail mid-flight so the local link doesn't get written.
        const updateOneSpy = vi.spyOn(itemsDAO, 'updateOne').mockRejectedValueOnce(new Error('mongo blip'));

        const res1 = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res1.status).toBe(200);

        // After call #1: GCal got a create, but the item is still unlinked locally.
        expect(createSpy).toHaveBeenCalledOnce();
        // Compute the expected id directly from the helper so the assertion fails loudly if the
        // hashing scheme changes — a fragile mock-call-by-index lookup would silently pass.
        const expectedId = buildDeterministicGCalId('item-idempotent-1', 'int-1');
        const idAfterFirst = createSpy.mock.calls[0]![3]?.id;
        expect(idAfterFirst).toBe(expectedId);
        const itemAfterFirst = await itemsDAO.findByOwnerAndId('item-idempotent-1', userId);
        expect(itemAfterFirst?.calendarEventId).toBeUndefined();

        // Restore updateOne for the second pass; rig createEvent to throw 409 (the deterministic
        // id is already on Google's side), simulating the expected GCal response on retry.
        updateOneSpy.mockRestore();
        createSpy.mockReset();
        const conflictErr = Object.assign(new Error('Conflict'), { code: 409 });
        createSpy.mockRejectedValue(conflictErr);

        const res2 = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res2.status).toBe(200);

        // The retry must send the SAME deterministic id (proving idempotency) and treat 409 as
        // success-with-existing — the item is now linked locally with that id.
        expect(createSpy).toHaveBeenCalledOnce();
        expect(createSpy.mock.calls[0]![3]?.id).toBe(expectedId);

        const linked = await itemsDAO.findByOwnerAndId('item-idempotent-1', userId);
        expect(linked?.calendarEventId).toBe(expectedId);
        // 409-relink has no insert response to read htmlLink from (and we deliberately skip an
        // extra events.get on this rare retry path) — the link stays unset, as before.
        expect(linked?.htmlLink).toBeUndefined();
    });

    // ── Idempotent backfill: relink naked routines onto real twins instead of cloning ──────────
    // These exercise runOutboundBackfill's relink-first path (matchExistingMasterForRoutine). To
    // reproduce the production bug (the real master is NOT in the incremental delta but IS on the
    // calendar), the config carries a syncToken so inbound sync takes the incremental path
    // (listEventsIncremental → empty), while the matcher's full-master fetch (listEventsFull)
    // returns the live twin. A naked recurring master (rrule, BYDAY=MO, 09:00 Jerusalem/30min)
    // matches makeRoutine's default template.
    describe('relink-first (matchExistingMasterForRoutine)', () => {
        const masterStart = '2025-06-09T09:00:00+03:00'; // 09:00 Jerusalem / 30-min → makeRoutine default template
        const masterEnd = '2025-06-09T09:30:00+03:00';
        const masterUpdated = '2025-06-09T08:00:00.000Z';

        async function insertIntegrationWithSyncedConfig(userId: string) {
            const integration = makeIntegration(userId);
            await calendarIntegrationsDAO.insertEncrypted(integration);
            // syncToken present → inbound sync uses the incremental path, so the unmodified real master
            // never re-imports inbound (matching the disconnect/reconnect repro this fix targets).
            await calendarSyncConfigsDAO.insertOne(makeSyncConfig(userId, integration._id, { syncToken: 'tok-existing' }));
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue({ events: [], nextSyncToken: 'tok-next' });
        }

        function makeMaster(overrides: Partial<GCalEvent> = {}): GCalEvent {
            return {
                id: 'real-native-gcal-id',
                title: 'Standup',
                timeStart: masterStart,
                timeEnd: masterEnd,
                updated: masterUpdated,
                status: 'confirmed',
                recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                ...overrides,
            };
        }

        it('(i-a) empty master list → CREATE (genuine never-synced app routine)', async () => {
            const sessionCookie = await loginAsAlice();
            const userId = await getUserId(sessionCookie);
            await insertIntegrationWithSyncedConfig(userId);
            await routinesDAO.insertOne(makeRoutine(userId, { _id: 'routine-create-1' }));

            vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-full' });
            const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('gcal-created-1');

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            const body = (await res.json()) as { pushedRoutines: number; relinkedRoutines: number };
            expect(body.pushedRoutines).toBe(1);
            expect(body.relinkedRoutines).toBe(0);

            expect(createSpy).toHaveBeenCalledOnce();
            const updated = await routinesDAO.findByOwnerAndId('routine-create-1', userId);
            expect(updated?.calendarEventId).toBe('gcal-created-1');
            expect(updated?.calendarIntegrationId).toBe('int-1');
            expect(updated?.calendarSyncConfigId).toBe('sync-config-1');
        });

        it('(i-b) non-matching master present → CREATE', async () => {
            const sessionCookie = await loginAsAlice();
            const userId = await getUserId(sessionCookie);
            await insertIntegrationWithSyncedConfig(userId);
            await routinesDAO.insertOne(makeRoutine(userId, { _id: 'routine-create-2' }));

            vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
            // Different title → not a twin.
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
                events: [makeMaster({ title: 'A different meeting' })],
                nextSyncToken: 'tok-full',
            });
            const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('gcal-created-2');

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            const body = (await res.json()) as { pushedRoutines: number; relinkedRoutines: number };
            expect(body.pushedRoutines).toBe(1);
            expect(body.relinkedRoutines).toBe(0);
            expect(createSpy).toHaveBeenCalledOnce();
        });

        it('(ii) matching native-id master → RELINK, no clone minted', async () => {
            const sessionCookie = await loginAsAlice();
            const userId = await getUserId(sessionCookie);
            await insertIntegrationWithSyncedConfig(userId);
            await routinesDAO.insertOne(makeRoutine(userId, { _id: 'routine-relink-1' }));

            vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [makeMaster()], nextSyncToken: 'tok-full' });
            const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent');

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            const body = (await res.json()) as { pushedRoutines: number; relinkedRoutines: number };
            expect(body.pushedRoutines).toBe(0);
            expect(body.relinkedRoutines).toBe(1);

            // No clone master pushed to Google.
            expect(createSpy).not.toHaveBeenCalled();
            const relinked = await routinesDAO.findByOwnerAndId('routine-relink-1', userId);
            expect(relinked?.calendarEventId).toBe('real-native-gcal-id');
            expect(relinked?.calendarIntegrationId).toBe('int-1');
            expect(relinked?.calendarSyncConfigId).toBe('sync-config-1');
            // Exactly one routine on that event id — the active-partial unique index holds.
            const onEvent = await routinesDAO.findArray({ user: userId, calendarEventId: 'real-native-gcal-id' });
            expect(onEvent).toHaveLength(1);
            // One op recorded so other devices learn about the relink.
            const ops = await operationsDAO.findArray({ user: userId, entityType: 'routine', entityId: 'routine-relink-1' });
            expect(ops).toHaveLength(1);
            expect(ops[0]!.snapshot).toMatchObject({ calendarEventId: 'real-native-gcal-id' });
        });

        it('(ii-allday) all-day naked routine + all-day master → RELINK', async () => {
            const sessionCookie = await loginAsAlice();
            const userId = await getUserId(sessionCookie);
            await insertIntegrationWithSyncedConfig(userId);
            await routinesDAO.insertOne(
                makeRoutine(userId, { _id: 'routine-allday', title: 'OOO', calendarItemTemplate: { allDay: true }, rrule: 'FREQ=DAILY' }),
            );

            vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
                events: [
                    makeMaster({
                        id: 'real-allday-id',
                        title: 'OOO',
                        allDay: true,
                        timeStart: '2025-06-09',
                        timeEnd: '2025-06-10',
                        recurrence: ['RRULE:FREQ=DAILY'],
                    }),
                ],
                nextSyncToken: 'tok-full',
            });
            const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent');

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            const body = (await res.json()) as { relinkedRoutines: number };
            expect(body.relinkedRoutines).toBe(1);
            expect(createSpy).not.toHaveBeenCalled();
            const relinked = await routinesDAO.findByOwnerAndId('routine-allday', userId);
            expect(relinked?.calendarEventId).toBe('real-allday-id');
        });

        it('(iii) capped-only master (UNTIL) → CREATE (B1 full-master fetch guarantees live twins are seen, so create is safe)', async () => {
            const sessionCookie = await loginAsAlice();
            const userId = await getUserId(sessionCookie);
            await insertIntegrationWithSyncedConfig(userId);
            await routinesDAO.insertOne(makeRoutine(userId, { _id: 'routine-capped-create' }));

            vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
            // The only master with this title/template is capped (past UNTIL) → not a live twin → CREATE.
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
                events: [makeMaster({ recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20250101T000000Z'] })],
                nextSyncToken: 'tok-full',
            });
            const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('gcal-created-3');

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            const body = (await res.json()) as { pushedRoutines: number; relinkedRoutines: number };
            expect(body.pushedRoutines).toBe(1);
            expect(body.relinkedRoutines).toBe(0);
            expect(createSpy).toHaveBeenCalledOnce();
        });

        it('skips a master already backing another routine (knownRoutineEventIds) → CREATE', async () => {
            const sessionCookie = await loginAsAlice();
            const userId = await getUserId(sessionCookie);
            await insertIntegrationWithSyncedConfig(userId);
            // An existing linked routine already owns the only matching master. The naked routine must
            // NOT be relinked onto it (that would collide on the unique index / split pairs) → CREATE.
            await routinesDAO.insertOne(
                makeRoutine(userId, {
                    _id: 'routine-owner',
                    calendarEventId: 'real-native-gcal-id',
                    calendarIntegrationId: 'int-1',
                    calendarSyncConfigId: 'sync-config-1',
                }),
            );
            await routinesDAO.insertOne(makeRoutine(userId, { _id: 'routine-naked-skip' }));

            vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [makeMaster()], nextSyncToken: 'tok-full' });
            const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('gcal-created-4');

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            const body = (await res.json()) as { pushedRoutines: number; relinkedRoutines: number };
            expect(body.relinkedRoutines).toBe(0);
            expect(body.pushedRoutines).toBe(1);
            expect(createSpy).toHaveBeenCalledOnce();
        });

        it('(idempotency) sync twice with twin present → relink once, second run is a no-op', async () => {
            const sessionCookie = await loginAsAlice();
            const userId = await getUserId(sessionCookie);
            await insertIntegrationWithSyncedConfig(userId);
            await routinesDAO.insertOne(makeRoutine(userId, { _id: 'routine-idem' }));

            vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [makeMaster()], nextSyncToken: 'tok-full' });
            const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent');

            const res1 = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res1.status).toBe(200);
            expect(((await res1.json()) as { relinkedRoutines: number }).relinkedRoutines).toBe(1);

            const res2 = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res2.status).toBe(200);
            // Second run: the routine is now linked, so the backfill query excludes it — nothing to do.
            const body2 = (await res2.json()) as { pushedRoutines: number; relinkedRoutines: number };
            expect(body2.relinkedRoutines).toBe(0);
            expect(body2.pushedRoutines).toBe(0);
            expect(createSpy).not.toHaveBeenCalled();
            const onEvent = await routinesDAO.findArray({ user: userId, calendarEventId: 'real-native-gcal-id' });
            expect(onEvent).toHaveLength(1);
        });

        it('(dangling integrationId) routine with calendarIntegrationId but no calendarEventId → NOT eligible → CREATE skipped (no clone)', async () => {
            const sessionCookie = await loginAsAlice();
            const userId = await getUserId(sessionCookie);
            await insertIntegrationWithSyncedConfig(userId);
            // Eligibility requires BOTH calendarEventId and calendarIntegrationId absent (matching the
            // relink `$set` filter). A routine carrying a dangling integrationId must be excluded entirely
            // — neither relinked nor cloned — so it can't fall through to a `gtd*` create.
            await routinesDAO.insertOne(makeRoutine(userId, { _id: 'routine-dangling', calendarIntegrationId: 'int-OLD' }));

            vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [makeMaster()], nextSyncToken: 'tok-full' });
            const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent');

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            const body = (await res.json()) as { pushedRoutines: number; relinkedRoutines: number };
            expect(body.relinkedRoutines).toBe(0);
            expect(body.pushedRoutines).toBe(0);
            expect(createSpy).not.toHaveBeenCalled();
            // Unchanged — still naked-but-dangling, awaiting the inbound restore path.
            const unchanged = await routinesDAO.findByOwnerAndId('routine-dangling', userId);
            expect(unchanged?.calendarEventId).toBeUndefined();
        });

        it('(rebased-suffix master) a `_R<anchor>` split successor is never a backfill twin → CREATE', async () => {
            const sessionCookie = await loginAsAlice();
            const userId = await getUserId(sessionCookie);
            await insertIntegrationWithSyncedConfig(userId);
            await routinesDAO.insertOne(makeRoutine(userId, { _id: 'routine-rebased' }));

            vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
            // The only matching master carries an `_R<anchor>` rebased suffix — the live tail of a GCal
            // split, owned by the split path. The backfill matcher must skip it and CREATE instead.
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
                events: [makeMaster({ id: 'real-native-gcal-id_R20250609T060000Z' })],
                nextSyncToken: 'tok-full',
            });
            const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('gcal-created-rebased');

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            const body = (await res.json()) as { pushedRoutines: number; relinkedRoutines: number };
            expect(body.relinkedRoutines).toBe(0);
            expect(body.pushedRoutines).toBe(1);
            expect(createSpy).toHaveBeenCalledOnce();
        });

        it('(multiple twins) two matching open masters → relinks onto exactly one (first wins), no clone', async () => {
            const sessionCookie = await loginAsAlice();
            const userId = await getUserId(sessionCookie);
            await insertIntegrationWithSyncedConfig(userId);
            await routinesDAO.insertOne(makeRoutine(userId, { _id: 'routine-multi' }));

            vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
            // Two distinct open masters share the same title/rrule/template. The matcher takes the first;
            // the contract is "relink onto one, never clone".
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
                events: [makeMaster({ id: 'twin-A' }), makeMaster({ id: 'twin-B' })],
                nextSyncToken: 'tok-full',
            });
            const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent');

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            const body = (await res.json()) as { relinkedRoutines: number };
            expect(body.relinkedRoutines).toBe(1);
            expect(createSpy).not.toHaveBeenCalled();
            const relinked = await routinesDAO.findByOwnerAndId('routine-multi', userId);
            expect(relinked?.calendarEventId).toBe('twin-A');
        });
    });

    it('trashes an existing item when its GCal event is cancelled', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-1',
            user: userId,
            status: 'calendar',
            title: 'Old event',
            calendarEventId: 'evt-cancelled',
            calendarIntegrationId: 'int-1',
            createdTs: now,
            updatedTs: now,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-cancelled', title: 'Old event', timeStart: now, timeEnd: now, updated: now, status: 'cancelled' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-1' });
        expect(item?.status).toBe('trash');
    });
});
