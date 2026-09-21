/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import dayjs from 'dayjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { regenerateFutureRoutineItems } from '../lib/routineItemRegeneration.js';
import type { RoutineInterface } from '../types/entities.js';
import { app, getUserId, insertIntegrationWithConfig, loginAsAlice, makeRoutine, useCalendarTestLifecycle } from './calendarTestKit.js';
import { authenticatedRequest } from './helpers.js';

useCalendarTestLifecycle();

// ─── Phase 1c: GCal-owned field-level merge + all-day + cancelledByGCal ───
//
// Covers the inbound paths in routes/calendar.ts: createNewCalendarItem (all-day inbound),
// updateExistingCalendarItem (GCal-newer + GCal-older field-level merge, attendee-clear), the
// cancelled branch (cancelledByGCal stamp), and createRoutineFromGCal (all-day routine template).

describe('POST /calendar/integrations/:id/sync — Phase 1c field-level merge', () => {
    beforeEach(() => {
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
    });

    it('inbound GCal-newer event overwrites the local title AND the attendees array (basic merge)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const localAnchor = dayjs().subtract(1, 'hour').toISOString();
        const eventUpdated = dayjs().toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-merge-newer',
            user: userId,
            status: 'calendar',
            title: 'Local title',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-merge-newer',
            calendarIntegrationId: 'int-1',
            attendees: [{ email: 'old@example.com', responseStatus: 'needsAction' }],
            createdTs: localAnchor,
            updatedTs: localAnchor,
            lastSyncedFromGCalTs: localAnchor,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-merge-newer',
                    title: 'GCal title',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: eventUpdated,
                    status: 'confirmed',
                    attendees: [
                        { email: 'a@example.com', responseStatus: 'accepted' },
                        { email: 'b@example.com', responseStatus: 'declined' },
                    ],
                    organizer: { email: 'a@example.com' },
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-merge-newer' });
        // Structural overwrite when GCal is newer: title updated.
        expect(item?.title).toBe('GCal title');
        // GCal-owned overwrite: attendees + organizer mirror the inbound payload exactly.
        expect(item?.attendees).toEqual([
            { email: 'a@example.com', responseStatus: 'accepted' },
            { email: 'b@example.com', responseStatus: 'declined' },
        ]);
        expect(item?.organizer).toEqual({ email: 'a@example.com' });
    });

    it('inbound GCal-older event preserves the local title BUT still overwrites attendees (GCal-owned policy)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // localAnchor newer than eventUpdated → structurallyNewer = false → title stays local.
        const eventUpdated = dayjs().subtract(2, 'hour').toISOString();
        const localAnchor = dayjs().toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-merge-older',
            user: userId,
            status: 'calendar',
            title: 'Local title wins',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-merge-older',
            calendarIntegrationId: 'int-1',
            attendees: [{ email: 'stale@example.com', responseStatus: 'needsAction' }],
            createdTs: eventUpdated,
            updatedTs: localAnchor,
            lastSyncedFromGCalTs: localAnchor,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-merge-older',
                    title: 'GCal stale title (should not win)',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: eventUpdated,
                    status: 'confirmed',
                    attendees: [{ email: 'fresh@example.com', responseStatus: 'accepted' }],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-merge-older' });
        // Title is structural and gated — local wins because GCal is older.
        expect(item?.title).toBe('Local title wins');
        // Attendees are GCal-owned — always overwritten, even when GCal is older.
        expect(item?.attendees).toEqual([{ email: 'fresh@example.com', responseStatus: 'accepted' }]);
    });

    it('inbound event without attendees clears the local stale attendees (GCal-owned absent ⇒ delete)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const localAnchor = dayjs().subtract(1, 'hour').toISOString();
        const eventUpdated = dayjs().toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-attendees-clear',
            user: userId,
            status: 'calendar',
            title: 'Stale attendees',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-attendees-clear',
            calendarIntegrationId: 'int-1',
            attendees: [{ email: 'leaving@example.com', responseStatus: 'declined' }],
            organizer: { email: 'leaving@example.com' },
            createdTs: localAnchor,
            updatedTs: localAnchor,
            lastSyncedFromGCalTs: localAnchor,
        });

        // Inbound event omits attendees entirely (GCal returned an empty array → parser drops to undefined).
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-attendees-clear',
                    title: 'Stale attendees',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: eventUpdated,
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-attendees-clear' });
        // Both GCal-owned fields cleared — neither attendees nor organizer survives the replace.
        expect(item?.attendees).toBeUndefined();
        expect(item?.organizer).toBeUndefined();
    });

    it('inbound event writes meetingLink/location/htmlLink onto an existing item (GCal-owned merge)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const localAnchor = dayjs().subtract(1, 'hour').toISOString();
        const eventUpdated = dayjs().toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-links-write',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-links-write',
            calendarIntegrationId: 'int-1',
            createdTs: localAnchor,
            updatedTs: localAnchor,
            lastSyncedFromGCalTs: localAnchor,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-links-write',
                    title: 'Standup',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: eventUpdated,
                    status: 'confirmed',
                    meetingLink: 'https://meet.google.com/abc-defg-hij',
                    location: 'Room 4B',
                    htmlLink: 'https://calendar.google.com/event?eid=links-write',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-links-write' });
        expect(item?.meetingLink).toBe('https://meet.google.com/abc-defg-hij');
        expect(item?.location).toBe('Room 4B');
        expect(item?.htmlLink).toBe('https://calendar.google.com/event?eid=links-write');
    });

    it('inbound event without a meeting link clears a stale local meetingLink (GCal-owned absent ⇒ delete)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const localAnchor = dayjs().subtract(1, 'hour').toISOString();
        const eventUpdated = dayjs().toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-links-clear',
            user: userId,
            status: 'calendar',
            title: 'Meeting unscheduled',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-links-clear',
            calendarIntegrationId: 'int-1',
            meetingLink: 'https://meet.google.com/gone',
            location: 'Old Room',
            createdTs: localAnchor,
            updatedTs: localAnchor,
            lastSyncedFromGCalTs: localAnchor,
        });

        // Meeting removed on GCal: the event no longer carries hangoutLink/conferenceData/location.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-links-clear',
                    title: 'Meeting unscheduled',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: eventUpdated,
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-links-clear' });
        expect(item?.meetingLink).toBeUndefined();
        expect(item?.location).toBeUndefined();
    });

    it('cancelled inbound event trashes the item AND stamps cancelledByGCal: true', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-cancelled-flag',
            user: userId,
            status: 'calendar',
            title: 'About to be cancelled',
            timeStart: now,
            timeEnd: now,
            calendarEventId: 'evt-cancelled-flag',
            calendarIntegrationId: 'int-1',
            createdTs: now,
            updatedTs: now,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-cancelled-flag', title: 'About to be cancelled', timeStart: now, timeEnd: now, updated: now, status: 'cancelled' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-cancelled-flag' });
        expect(item?.status).toBe('trash');
        expect(item?.cancelledByGCal).toBe(true);
    });

    it('all-day inbound event creates an item with allDay: true and YYYY-MM-DD time fields', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // GCal exclusive-end: a single-day all-day event on May 27 stores end = May 28.
        const startDate = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const endDate = dayjs().add(2, 'day').format('YYYY-MM-DD');
        const updated = dayjs().toISOString();

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-allday-new',
                    title: 'Holiday',
                    timeStart: startDate,
                    timeEnd: endDate,
                    updated,
                    status: 'confirmed',
                    allDay: true,
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ calendarEventId: 'evt-allday-new' });
        expect(item).not.toBeNull();
        expect(item?.allDay).toBe(true);
        expect(item?.timeStart).toBe(startDate);
        expect(item?.timeEnd).toBe(endDate);
        expect(item?.status).toBe('calendar');
    });

    it('createRoutineFromGCal mirrors the master organizer/attendees/eventType onto the routine doc, and generated items inherit them', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. Under TZ=UTC (CI), the old
        // `dayjs().hour(9)` produced 09:00 UTC = 12:00 Jerusalem, so the inferred schedule differed from
        // the stored template → the sync regenerated (churned) items instead of converging. See line ~8817.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();
        const tomorrowAt10 = dayjs().add(1, 'day').hour(10).minute(0).second(0).millisecond(0).toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-master-with-attendees',
                    title: 'Yuval <> Gilad',
                    timeStart: tomorrowAt9,
                    timeEnd: tomorrowAt10,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                    organizer: { email: 'yuval@example.com', displayName: 'Yuval' },
                    creator: { email: 'yuval@example.com' },
                    attendees: [
                        { email: 'gilad@example.com', responseStatus: 'accepted' },
                        { email: 'yuval@example.com', responseStatus: 'accepted', self: true },
                    ],
                    responseStatus: 'accepted',
                    eventType: 'default',
                },
            ],
            nextSyncToken: 'tok-attendees',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'gcal-master-with-attendees' });
        expect(routine).not.toBeNull();
        // Routine doc now carries the master attendee list verbatim.
        expect(routine?.attendees).toHaveLength(2);
        expect(routine?.organizer?.email).toBe('yuval@example.com');
        expect(routine?.eventType).toBe('default');

        // Every generated item carries the same attendees mirrored from the master.
        const items = await itemsDAO.findArray({ user: userId, routineId: routine?._id ?? '' });
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            expect(item.attendees).toHaveLength(2);
            expect(item.organizer?.email).toBe('yuval@example.com');
            expect(item.eventType).toBe('default');
        }
    });

    it('createRoutineFromGCal mirrors the master meetingLink/location/htmlLink onto the routine doc and every generated item', async () => {
        // The weekly-standup-with-a-fixed-Meet-link case: recurring instances are managed by the
        // routine surface, so the conferencing link must thread master → routine → generated items.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. Under TZ=UTC (CI), the old
        // `dayjs().hour(9)` produced 09:00 UTC = 12:00 Jerusalem, so the inferred schedule differed from
        // the stored template → the sync regenerated (churned) items instead of converging. See line ~8817.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();
        const tomorrowAt10 = dayjs().add(1, 'day').hour(10).minute(0).second(0).millisecond(0).toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-master-with-meet',
                    title: 'Weekly standup',
                    timeStart: tomorrowAt9,
                    timeEnd: tomorrowAt10,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                    meetingLink: 'https://meet.google.com/standup-link',
                    location: 'HQ Room 4B',
                    htmlLink: 'https://calendar.google.com/event?eid=standup',
                },
            ],
            nextSyncToken: 'tok-meet',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'gcal-master-with-meet' });
        expect(routine?.meetingLink).toBe('https://meet.google.com/standup-link');
        expect(routine?.location).toBe('HQ Room 4B');
        expect(routine?.htmlLink).toBe('https://calendar.google.com/event?eid=standup');

        const items = await itemsDAO.findArray({ user: userId, routineId: routine?._id ?? '' });
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            expect(item.meetingLink).toBe('https://meet.google.com/standup-link');
            expect(item.location).toBe('HQ Room 4B');
            expect(item.htmlLink).toBe('https://calendar.google.com/event?eid=standup');
        }
    });

    it('createRoutineFromGCal with an all-day recurring master builds template = { allDay: true } and generates all-day items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // GCal recurring all-day master: start/end are YYYY-MM-DD strings, allDay: true.
        const startDate = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const endDate = dayjs().add(2, 'day').format('YYYY-MM-DD');
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-allday-master',
                    title: 'Daily walk',
                    timeStart: startDate,
                    timeEnd: endDate,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    allDay: true,
                    recurrence: ['RRULE:FREQ=DAILY'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        // Phase 8: the all-day routine path now generates items end-to-end. Sync must succeed
        // (200) and the resulting items must carry allDay=true with YYYY-MM-DD time strings.
        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-allday-master' });
        expect(routine).not.toBeNull();
        expect(routine?.calendarItemTemplate).toEqual({ allDay: true });
        expect(routine?.title).toBe('Daily walk');
        expect(routine?.rrule).toBe('FREQ=DAILY');

        const items = await itemsDAO.findArray({ user: userId, routineId: routine?._id ?? '' });
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            expect(item.allDay).toBe(true);
            expect(item.timeStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(item.timeEnd).toBe(dayjs(item.timeStart).add(1, 'day').format('YYYY-MM-DD'));
        }
    });

    // Regression: updateRoutineFromGCal previously recomputed `calendarItemTemplate` as
    // `{ timeOfDay, duration }` unconditionally, so a structurally-newer all-day master clobbered the
    // routine's `{ allDay: true }` template — for an all-day event timeStart is a YYYY-MM-DD string, so
    // extractLocalTime/diff produce junk (timeOfDay '03:00', duration 1440), and the banner renders
    // as 03:00–03:00. The update path now mirrors the create path's all-day branch.
    it('updateRoutineFromGCal keeps template = { allDay: true } when a newer all-day master arrives (no clobber to timed)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const startDate = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const endDate = dayjs().add(2, 'day').format('YYYY-MM-DD');

        // Existing all-day routine with a STALE GCal-truth anchor so the inbound master is structurally newer.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-allday',
                calendarEventId: 'recurring-allday-master',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'cfg-1',
                rrule: 'FREQ=DAILY',
                calendarItemTemplate: { allDay: true },
                lastSyncedFromGCalTs: '2020-01-01T00:00:00.000Z',
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'recurring-allday-master',
                    title: 'Daily walk (renamed)',
                    timeStart: startDate,
                    timeEnd: endDate,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    allDay: true,
                    recurrence: ['RRULE:FREQ=DAILY'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        // Seed an existing future all-day item so propagateMasterScheduleChanges has a target — the
        // assertion loop below is then non-vacuous.
        await itemsDAO.insertOne({
            _id: 'item-allday-future',
            user: userId,
            status: 'calendar',
            title: 'Daily walk',
            routineId: 'routine-allday',
            calendarInstanceEventId: `recurring-allday-master_${startDate.replace(/-/g, '')}`,
            allDay: true,
            timeStart: startDate,
            timeEnd: endDate,
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'recurring-allday-master' });
        expect(routine?.title).toBe('Daily walk (renamed)');
        // The structural update applied (title changed) but the template stayed all-day — not { timeOfDay, duration }.
        // Pre-fix this would have been { timeOfDay: '03:00', duration: 1440 } (junk from parsing a YYYY-MM-DD string).
        expect(routine?.calendarItemTemplate).toEqual({ allDay: true });

        // Existing future items keep date-only time strings (never 03:00 datetimes) after propagation.
        const items = await itemsDAO.findArray({ user: userId, routineId: routine?._id ?? '' });
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            expect(item.allDay).toBe(true);
            expect(item.timeStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
    });

    // Replacement (not merge) semantics: a routine previously TIMED that becomes all-day on GCal must
    // have its `{ timeOfDay, duration }` fully replaced by `{ allDay: true }` — no stale timed fields left.
    it('updateRoutineFromGCal replaces a timed template with { allDay: true } on a timed→all-day transition', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const startDate = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const endDate = dayjs().add(2, 'day').format('YYYY-MM-DD');

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-was-timed',
                calendarEventId: 'master-timed-to-allday',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'cfg-1',
                rrule: 'FREQ=DAILY',
                calendarItemTemplate: { timeOfDay: '09:00', duration: 60 },
                lastSyncedFromGCalTs: '2020-01-01T00:00:00.000Z',
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-timed-to-allday',
                    title: 'Now all-day',
                    timeStart: startDate,
                    timeEnd: endDate,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    allDay: true,
                    recurrence: ['RRULE:FREQ=DAILY'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ calendarEventId: 'master-timed-to-allday' });
        // Whole object replaced — timeOfDay/duration are gone, not merged alongside allDay.
        expect(routine?.calendarItemTemplate).toEqual({ allDay: true });
        expect(routine?.calendarItemTemplate?.timeOfDay).toBeUndefined();
        expect(routine?.calendarItemTemplate?.duration).toBeUndefined();
    });

    // Companion to the write-path fix: findExistingRoutineForEvent must relink a NAKED all-day routine
    // to its re-imported all-day master. Pre-fix the naked query matched on timeOfDay/duration derived
    // from a YYYY-MM-DD string, which a { allDay: true } routine lacks → zero match → duplicate routine.
    it('findExistingRoutineForEvent relinks a naked all-day routine instead of creating a duplicate', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const startDate = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const endDate = dayjs().add(2, 'day').format('YYYY-MM-DD');

        // Naked all-day routine: no calendarEventId/calendarIntegrationId (link dropped on disconnect-with-keep).
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-naked-allday',
                title: 'Anniversary',
                rrule: 'FREQ=YEARLY',
                calendarItemTemplate: { allDay: true },
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'master-naked-allday',
                    title: 'Anniversary',
                    timeStart: startDate,
                    timeEnd: endDate,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    allDay: true,
                    recurrence: ['RRULE:FREQ=YEARLY'],
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Exactly one routine for this title — the naked one was relinked, not duplicated.
        const matching = await routinesDAO.findArray({ user: userId, title: 'Anniversary' });
        expect(matching).toHaveLength(1);
        const [relinked] = matching;
        if (!relinked) throw new Error('expected the naked routine to survive');
        expect(relinked._id).toBe('routine-naked-allday');
        expect(relinked.calendarEventId).toBe('master-naked-allday');
        expect(relinked.calendarItemTemplate).toEqual({ allDay: true });
    });

    // Regression: pre-fix, GCal returning a rebased-master id (`<master>_R<YYYYMMDDTHHmmss>`) led to
    // a doubly-suffixed `calendarInstanceEventId` on every generated item, causing reconcile to
    // orphan-create a duplicate item per occurrence. The import path now normalizes `event.id` at
    // its boundary; this test pins the contract that a bare-stored routine + suffixed inbound id
    // → exactly one routine (not two), and stored `calendarEventId` stays bare.
    it('importRecurringEventAsRoutine normalizes a suffixed _R<…> master id and matches a bare-stored routine (no duplicate)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareMasterId = 'mleem99efhim4a0tsh3s86797o';
        const suffixedMasterId = `${bareMasterId}_R20260519T123000`;
        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. Under TZ=UTC (CI), the old
        // `dayjs().hour(9)` produced 09:00 UTC = 12:00 Jerusalem, so the inferred schedule differed from
        // the stored template → the sync regenerated (churned) items instead of converging. See line ~8817.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-bare',
                calendarEventId: bareMasterId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'cfg-1',
            }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: suffixedMasterId,
                    title: 'Standup',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-rebased',
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routines = await routinesDAO.findArray({ user: userId });
        // Exactly the one pre-existing routine — no duplicate created by the suffixed inbound id.
        expect(routines).toHaveLength(1);
        const [routine] = routines;
        if (!routine) throw new Error('expected one routine');
        expect(routine._id).toBe('routine-bare');
        expect(routine.calendarEventId).toBe(bareMasterId);
    });

    // Regression: a "this and following" split makes GCal report the series as TWO masters sharing one
    // bare id — the capped base `<id>` (UNTIL) and the open successor `<id>_R<anchor>`. Re-reporting that
    // pair every webhook fire used to mint a NEW successor routine each cycle (phase-1 capped the live
    // successor, phase-2 couldn't find an active routine on the bare id → created another), growing an
    // unbounded routine chain on RSVP-churny series. The fix keys split-successor onboarding on the stable
    // raw `_R` id (calendarRebasedEventId): the same successor re-arriving updates the SAME routine and
    // reactivates it if phase-1 wrongly capped it. This test re-delivers the split batch twice and asserts
    // the routine set never grows past the original base + successor.
    it('re-importing a split (capped base + open _R successor) converges — no new successor routine per sync', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'split-converge-master';
        const rebasedId = `${bareId}_R20260604T060000Z`;
        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. Under TZ=UTC (CI), the old
        // `dayjs().hour(9)` produced 09:00 UTC = 12:00 Jerusalem, so the inferred schedule differed from
        // the stored template → the sync regenerated (churned) items instead of converging. See line ~8817.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();

        // Pre-existing state: a capped base routine (the historical segment) + an active open successor
        // already onboarded and keyed on the raw rebased id.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260603T205959Z',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-successor',
                active: true,
                rrule: 'FREQ=WEEKLY;BYDAY=TH',
                calendarEventId: bareId,
                calendarRebasedEventId: rebasedId,
                splitFromRoutineId: 'routine-base',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );

        // GCal re-reports BOTH masters in one batch (the recurring shape, not single instances). Mock both
        // full and incremental fetch so cycle 2 (which runs incrementally once cycle 1 stored a syncToken)
        // re-delivers the same pair. Stub watchEvents so webhook renewal doesn't hit the unmocked OAuth path.
        const splitBatch = {
            events: [
                {
                    id: bareId,
                    title: 'Upcoming POCs',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20260603T205959Z'],
                },
                {
                    id: rebasedId,
                    title: 'Upcoming POCs',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'],
                },
            ],
            nextSyncToken: 'tok-converge',
        };
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue(splitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue(splitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({ resourceId: 'res-1', expiration: dayjs().add(7, 'day').toISOString() });

        // Two sync cycles — the chain must not grow on either.
        for (let cycle = 0; cycle < 2; cycle++) {
            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
        }

        const routines = await routinesDAO.findArray({ user: userId, calendarEventId: bareId });
        // Exactly the two we started with — no fresh successor minted per cycle.
        expect(routines.map((r) => r._id).sort()).toEqual(['routine-base', 'routine-successor']);
        const successor = routines.find((r) => r._id === 'routine-successor');
        if (!successor) throw new Error('expected the successor to survive');
        // The successor stays active (reactivated if a same-batch base import capped it) and open.
        expect(successor.active).toBe(true);
        expect(successor.rrule).not.toContain('UNTIL=');
        // The base stays capped+inactive — never two active rows on the bare id (would violate the
        // uniq_active_routine_per_gcal_series partial index).
        expect(routines.find((r) => r._id === 'routine-base')?.active).toBe(false);
    });

    // Regression (Engineering-2 duplicate): a self-referential split (capped base + live successor on one
    // bare id) made the BARE master resolve to the live successor in phase 1 — rewriting it with the base's
    // capped rrule — while phase 2 reactivated it via the rebased id. The rrule oscillated bare↔UNTIL every
    // webhook fire, tripping `scheduleChanged` so `regenerateFutureRoutineItems` trashed+recreated ALL the
    // successor's future items each sync (the user saw stale duplicate rows + a web-push storm). The fix:
    // (1) phase 1 excludes the successor (bare master lands on the base only), and (2) regen reconciles by
    // occurrence date so an unchanged schedule is a no-op. Assert the successor's items are STABLE across
    // cycles — same ids, no fresh trash generation.
    it('a self-referential split does not churn the successor items across syncs', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'self-ref-split-master';
        const rebasedId = `${bareId}_R20260604T060000Z`;
        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. Under TZ=UTC (CI), the old
        // `dayjs().hour(9)` produced 09:00 UTC = 12:00 Jerusalem, so the inferred schedule differed from
        // the stored template → the sync regenerated (churned) items instead of converging. See line ~8817.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base-sr',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260603T205959Z',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-successor-sr',
                active: true,
                rrule: 'FREQ=WEEKLY;BYDAY=TH',
                calendarEventId: bareId,
                calendarRebasedEventId: rebasedId,
                splitFromRoutineId: 'routine-base-sr',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );

        const splitBatch = {
            events: [
                {
                    id: bareId,
                    title: 'Upcoming POCs',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20260603T205959Z'],
                },
                {
                    id: rebasedId,
                    title: 'Upcoming POCs',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'],
                },
            ],
            nextSyncToken: 'tok-self-ref',
        };
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue(splitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue(splitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({ resourceId: 'res-1', expiration: dayjs().add(7, 'day').toISOString() });

        // Seed the successor's future items the way onboarding would, then capture their ids. Pre-inserted
        // routines carry no items, so without this the churn (which trashes EXISTING items) has nothing to act on.
        const successor = await routinesDAO.findByOwnerAndId('routine-successor-sr', userId);
        if (!successor) throw new Error('expected the seeded successor routine');
        await regenerateFutureRoutineItems(successor, userId, dayjs().toISOString(), 'Asia/Jerusalem');
        const seeded = await itemsDAO.findArray({ user: userId, routineId: 'routine-successor-sr', status: 'calendar' });
        expect(seeded.length).toBeGreaterThan(0);
        const seededIds = seeded.map((i) => i._id).sort();

        // Two sync cycles re-deliver the identical split batch — must NOT churn the seeded items.
        for (let cycle = 0; cycle < 2; cycle++) {
            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
        }

        const liveAfter = await itemsDAO.findArray({ user: userId, routineId: 'routine-successor-sr', status: 'calendar' });
        // Same exact item ids — not trashed and recreated with fresh uuids each sync.
        expect(liveAfter.map((i) => i._id).sort()).toEqual(seededIds);
        // No trash generation produced for the successor's items across either cycle.
        const trashed = await itemsDAO.findArray({ user: userId, routineId: 'routine-successor-sr', status: 'trash' });
        expect(trashed).toHaveLength(0);
    });

    // Backfilling `calendarRebasedEventId` onto a pre-rollout successor (what the heal pass does for the
    // existing chain) makes it converge exactly like a natively-onboarded one. (An un-backfilled legacy
    // successor now ALSO self-heals — phase 2's active-series fallback re-keys it in place, see the
    // dedicated test below — but the heal-pass backfill remains the supported bulk remediation.)
    it('a backfilled calendarRebasedEventId makes a legacy successor converge', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'split-backfill-master';
        const rebasedId = `${bareId}_R20260604T060000Z`;
        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. Under TZ=UTC (CI), the old
        // `dayjs().hour(9)` produced 09:00 UTC = 12:00 Jerusalem, so the inferred schedule differed from
        // the stored template → the sync regenerated (churned) items instead of converging. See line ~8817.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base-bf',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260603T205959Z',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );
        // Legacy successor AFTER backfill: the heal pass has written calendarRebasedEventId onto it.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-successor-bf',
                active: true,
                rrule: 'FREQ=WEEKLY;BYDAY=TH',
                calendarEventId: bareId,
                calendarRebasedEventId: rebasedId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );

        const splitBatch = {
            events: [
                {
                    id: bareId,
                    title: 'Upcoming POCs',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20260603T205959Z'],
                },
                {
                    id: rebasedId,
                    title: 'Upcoming POCs',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'],
                },
            ],
            nextSyncToken: 'tok-backfill',
        };
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue(splitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue(splitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({ resourceId: 'res-1', expiration: dayjs().add(7, 'day').toISOString() });

        for (let cycle = 0; cycle < 2; cycle++) {
            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
        }

        const routines = await routinesDAO.findArray({ user: userId, calendarEventId: bareId });
        expect(routines.map((r) => r._id).sort()).toEqual(['routine-base-bf', 'routine-successor-bf']);
        expect(routines.find((r) => r._id === 'routine-successor-bf')?.active).toBe(true);
    });

    // Regression (staging 2026-07-21, the E11000 sync jam): applying "this and all following" AGAIN to an
    // already-split series makes GCal report the open tail with a NEW `_R<anchor>` suffix. The stored
    // `calendarRebasedEventId` (previous anchor) never matches, the legacy fallback can't see the
    // still-active old successor (findExistingRoutineForEvent hides successors), so the import fell
    // through to create → E11000 against the old successor → recovery re-resolved to the inactive BASE,
    // reactivated it via `newlyLosesUntil` → unguarded E11000 #2 killed the whole sync. The sync token
    // never advanced, so every retry died at the same spot and one-off events were never imported.
    // The fix re-anchors the existing successor to the incoming rebased id and updates it in place.
    it('a re-split series (new _R anchor) re-anchors the existing successor — sync survives and one-offs import', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'resplit-master';
        const oldRebasedId = `${bareId}_R20260608T073000Z`;
        const newRebasedId = `${bareId}_R20260721T073000Z`;
        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. See the convergence test above.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();

        // Pre-existing split pair: capped inactive base + active successor keyed on the OLD anchor.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base-rs',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260607T205959Z',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-successor-rs',
                active: true,
                rrule: 'FREQ=WEEKLY;BYDAY=TH',
                calendarEventId: bareId,
                calendarRebasedEventId: oldRebasedId,
                splitFromRoutineId: 'routine-base-rs',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );

        // GCal reports the re-split: capped base (UNTIL moved forward) + the NEW `_R` open tail — plus a
        // one-off event that must still import (pre-fix, the sync died before reaching one-offs).
        const resplitBatch = {
            events: [
                {
                    id: bareId,
                    title: 'Daily - Team Leaders',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20260720T205959Z'],
                },
                {
                    id: newRebasedId,
                    title: 'Daily - Team Leaders',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE'],
                },
                {
                    id: 'oneoff-after-resplit',
                    title: 'triage-agent',
                    timeStart: dayjs(tomorrowAt9).add(2, 'hour').toISOString(),
                    timeEnd: dayjs(tomorrowAt9).add(3, 'hour').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                },
            ],
            nextSyncToken: 'tok-resplit',
        };
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue(resplitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue(resplitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({ resourceId: 'res-1', expiration: dayjs().add(7, 'day').toISOString() });

        // Two cycles: the first must survive (pre-fix it 502'd), the second must converge without growth.
        for (let cycle = 0; cycle < 2; cycle++) {
            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
        }

        const routines = await routinesDAO.findArray({ user: userId, calendarEventId: bareId });
        // No third routine minted — the old successor was re-anchored, not duplicated.
        expect(routines.map((r) => r._id).sort()).toEqual(['routine-base-rs', 'routine-successor-rs']);
        const successor = routines.find((r) => r._id === 'routine-successor-rs');
        if (!successor) throw new Error('expected the successor to survive');
        expect(successor.calendarRebasedEventId).toBe(newRebasedId);
        expect(successor.active).toBe(true);
        expect(successor.rrule).toBe('FREQ=WEEKLY;BYDAY=WE');
        const base = routines.find((r) => r._id === 'routine-base-rs');
        expect(base?.active).toBe(false);
        // The bare master's moved-forward UNTIL landed on the BASE (not the successor) — proving the
        // base update ran and stayed correctly targeted alongside the successor re-anchor.
        expect(base?.rrule).toContain('UNTIL=20260720');
        // The one-off after the recurring masters imported — the sync no longer dies mid-batch.
        const oneOff = await itemsDAO.findArray({ user: userId, calendarEventId: 'oneoff-after-resplit' });
        expect(oneOff).toHaveLength(1);
    });

    // Selection regression: when SEVERAL stale successors linger on one bare id (leftovers of the
    // pre-convergence chain bug) and none is active, the re-anchor must target exactly the
    // most-recently-updated one and mint nothing new. Locks in reanchorResplitSuccessor's
    // prefer-active-then-most-recent pick.
    it('re-anchoring with multiple lingering capped successors picks the most recent and mints nothing', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'multi-successor-master';
        const newRebasedId = `${bareId}_R20260721T073000Z`;
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base-ms',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260601T205959Z',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );
        // Two capped, inactive stale successors with different old anchors; the second is fresher.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-successor-old',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260610T205959Z',
                calendarEventId: bareId,
                calendarRebasedEventId: `${bareId}_R20260602T073000Z`,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                updatedTs: dayjs().subtract(10, 'day').toISOString(),
            }),
        );
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-successor-recent',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260620T205959Z',
                calendarEventId: bareId,
                calendarRebasedEventId: `${bareId}_R20260611T073000Z`,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                updatedTs: dayjs().subtract(1, 'day').toISOString(),
            }),
        );

        const batch = {
            events: [
                {
                    id: newRebasedId,
                    title: 'Standup',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'],
                },
            ],
            nextSyncToken: 'tok-multi',
        };
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue(batch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue(batch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({ resourceId: 'res-1', expiration: dayjs().add(7, 'day').toISOString() });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routines = await routinesDAO.findArray({ user: userId, calendarEventId: bareId });
        // Nothing minted — still exactly the base + the two successors.
        expect(routines.map((r) => r._id).sort()).toEqual(['routine-base-ms', 'routine-successor-old', 'routine-successor-recent']);
        const recent = routines.find((r) => r._id === 'routine-successor-recent');
        // The fresher successor was re-anchored, uncapped, and reactivated (slot was free).
        expect(recent?.calendarRebasedEventId).toBe(newRebasedId);
        expect(recent?.active).toBe(true);
        expect(recent?.rrule).toBe('FREQ=WEEKLY;BYDAY=TH');
        // The stale one is untouched.
        const old = routines.find((r) => r._id === 'routine-successor-old');
        expect(old?.calendarRebasedEventId).toBe(`${bareId}_R20260602T073000Z`);
        expect(old?.active).toBe(false);
    });

    // Regression for the replaceRoutineGuardingActiveSlot retry branch: the slot check and the
    // replaceById are not atomic, so a concurrent sync can claim the active slot in between. Simulate
    // that TOCTOU window by making the slot-check query (distinguished by its `_id: { $ne: … }`
    // exclusion) see a stale "slot free" state while the write hits the REAL unique index — the write
    // must retry keeping the routine inactive instead of aborting the whole sync with E11000.
    it('a reactivation losing the active-slot race keeps the routine inactive and the sync alive', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'slot-race-master';
        const rebasedId = `${bareId}_R20260604T060000Z`;
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base-race',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260603T205959Z',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-successor-race',
                active: true,
                rrule: 'FREQ=WEEKLY;BYDAY=TH',
                calendarEventId: bareId,
                calendarRebasedEventId: rebasedId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );

        const uncappedBatch = {
            events: [
                {
                    id: bareId,
                    title: 'Standup',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'],
                },
            ],
            nextSyncToken: 'tok-slot-race',
        };
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue(uncappedBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue(uncappedBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({ resourceId: 'res-1', expiration: dayjs().add(7, 'day').toISOString() });

        // Blind ONLY the slot-check query — it's the sole routinesDAO.findArray filter carrying an
        // `_id` exclusion. Every other query passes through, so the write below hits the real
        // uniq_active_routine_per_gcal_series index and throws a genuine E11000.
        const realFindArray = routinesDAO.findArray.bind(routinesDAO);
        vi.spyOn(routinesDAO, 'findArray').mockImplementation(async (filter = {}, options = {}) => {
            if ('_id' in filter && filter._id !== null && typeof filter._id === 'object') {
                return [];
            }
            return realFindArray(filter, options);
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const base = await routinesDAO.findByOwnerAndId('routine-base-race', userId);
        if (!base) throw new Error('expected the base routine to survive');
        // The open rrule landed but the retry kept the routine inactive — the successor holds the slot.
        expect(base.rrule).toBe('FREQ=WEEKLY;BYDAY=TH');
        expect(base.active).toBe(false);
        expect((await routinesDAO.findByOwnerAndId('routine-successor-race', userId))?.active).toBe(true);
    });

    // Regression: `newlyLosesUntil` reactivation must not collide with a live split successor. When GCal
    // uncaps the BARE master while a successor still holds the active slot on the same series key, the
    // pre-fix code flipped the capped base back to active → E11000 on replaceById → whole sync aborted.
    // The slot check keeps the base paused; the successor remains the live series.
    it('uncapping the bare master while a successor holds the active slot keeps the base inactive (no E11000 abort)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'uncap-race-master';
        const rebasedId = `${bareId}_R20260604T060000Z`;
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base-uc',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260603T205959Z',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-successor-uc',
                active: true,
                rrule: 'FREQ=WEEKLY;BYDAY=TH',
                calendarEventId: bareId,
                calendarRebasedEventId: rebasedId,
                splitFromRoutineId: 'routine-base-uc',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );

        // GCal reports ONLY the bare master, now uncapped (no UNTIL) — e.g. the user undid the split on
        // Google's side without the successor's tombstone arriving in the same delta.
        const uncappedBatch = {
            events: [
                {
                    id: bareId,
                    title: 'Standup',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'],
                },
            ],
            nextSyncToken: 'tok-uncap',
        };
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue(uncappedBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue(uncappedBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({ resourceId: 'res-1', expiration: dayjs().add(7, 'day').toISOString() });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const base = await routinesDAO.findByOwnerAndId('routine-base-uc', userId);
        if (!base) throw new Error('expected the base routine to survive');
        // The open rrule was applied but the base was NOT reactivated into the occupied slot.
        expect(base.rrule).toBe('FREQ=WEEKLY;BYDAY=TH');
        expect(base.active).toBe(false);
        const successor = await routinesDAO.findByOwnerAndId('routine-successor-uc', userId);
        expect(successor?.active).toBe(true);
    });

    // Regression (staging sync jam, 2026-07-19): a series split a SECOND time reports an open `_R` master
    // whose anchor differs from the successor routine's stored `calendarRebasedEventId`. The rebased-id
    // lookup misses; the old `existing?.active` fallback was dead code (findExistingRoutineForEvent's
    // base-only preference always returned the capped base) → phase 2 inserted a colliding twin →
    // E11000 → recovery picked the base and reactivated it into a SECOND E11000 → the whole sync died
    // every retry, blocking unrelated cancellation tombstones for days. The fix resolves the ACTIVE
    // routine on the bare id, updates it, and re-keys its rebased id to the new anchor.
    it('a re-split with a new _R anchor re-keys the existing successor instead of wedging the sync', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'resplit-master';
        const staleRebasedId = `${bareId}_R20260608T074500`;
        const newRebasedId = `${bareId}_R20260721T074500`;
        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) so extractLocalTime
        // round-trips to makeRoutine's timeOfDay "09:00" — see the convergence tests above.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base-rs',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260720T205959Z',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );
        // Live successor from the FIRST split — keyed on the now-stale anchor.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-successor-rs',
                active: true,
                rrule: 'FREQ=WEEKLY;BYDAY=TH',
                calendarEventId: bareId,
                calendarRebasedEventId: staleRebasedId,
                splitFromRoutineId: 'routine-base-rs',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );

        // GCal reports the capped base + the SECOND split's open successor (new anchor).
        const splitBatch = {
            events: [
                {
                    id: bareId,
                    title: 'Upcoming POCs',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20260720T205959Z'],
                },
                {
                    id: newRebasedId,
                    title: 'Upcoming POCs',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'],
                },
            ],
            nextSyncToken: 'tok-resplit',
        };
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue(splitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue(splitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({ resourceId: 'res-1', expiration: dayjs().add(7, 'day').toISOString() });

        for (let cycle = 0; cycle < 2; cycle++) {
            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
        }

        const routines = await routinesDAO.findArray({ user: userId, calendarEventId: bareId });
        // No colliding twin minted — still exactly base + successor.
        expect(routines.map((r) => r._id).sort()).toEqual(['routine-base-rs', 'routine-successor-rs']);
        const successor = routines.find((r) => r._id === 'routine-successor-rs');
        if (!successor) throw new Error('expected the successor to survive');
        expect(successor.active).toBe(true);
        expect(successor.rrule).not.toContain('UNTIL=');
        // Re-keyed onto the new anchor, so the next sync resolves it via findSplitSuccessorByRebasedId.
        expect(successor.calendarRebasedEventId).toBe(newRebasedId);
        expect(routines.find((r) => r._id === 'routine-base-rs')?.active).toBe(false);
    });

    // Regression: a LEGACY successor (pre-rebased-id rollout, no calendarRebasedEventId) used to be
    // unreachable in phase 2 — the base-only preference in findExistingRoutineForEvent made the old
    // `existing?.active` fallback dead code, so a re-reported split minted a colliding twin (E11000).
    // The active-series fallback now updates it in place AND backfills the rebased id.
    it('an un-backfilled legacy successor self-heals: updated in place and re-keyed', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareId = 'legacy-successor-master';
        const rebasedId = `${bareId}_R20260604T060000Z`;
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-base-lg',
                active: false,
                rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20260603T205959Z',
                calendarEventId: bareId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );
        // Legacy successor: NO calendarRebasedEventId.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-successor-lg',
                active: true,
                rrule: 'FREQ=WEEKLY;BYDAY=TH',
                calendarEventId: bareId,
                splitFromRoutineId: 'routine-base-lg',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );

        const splitBatch = {
            events: [
                {
                    id: bareId,
                    title: 'Upcoming POCs',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20260603T205959Z'],
                },
                {
                    id: rebasedId,
                    title: 'Upcoming POCs',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed' as const,
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'],
                },
            ],
            nextSyncToken: 'tok-legacy-heal',
        };
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue(splitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue(splitBatch);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({ resourceId: 'res-1', expiration: dayjs().add(7, 'day').toISOString() });

        for (let cycle = 0; cycle < 2; cycle++) {
            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
        }

        const routines = await routinesDAO.findArray({ user: userId, calendarEventId: bareId });
        expect(routines.map((r) => r._id).sort()).toEqual(['routine-base-lg', 'routine-successor-lg']);
        const successor = routines.find((r) => r._id === 'routine-successor-lg');
        if (!successor) throw new Error('expected the successor to survive');
        expect(successor.active).toBe(true);
        // Backfilled in place — the legacy row is now keyed like a natively-onboarded successor.
        expect(successor.calendarRebasedEventId).toBe(rebasedId);
    });

    // Fault-isolation regression: one broken recurring series must not abort the whole sync. This
    // mirrors the real incident — the routine-import crash ran BEFORE plain-event upserts, so a
    // cancellation tombstone for an unrelated item was never applied and the item stayed live for days.
    it('a failing recurring-series import does not block cancellation tombstones for other items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-blocked-tombstone',
            user: userId,
            status: 'calendar',
            title: 'Cancelled on GCal during the jam',
            timeStart: now,
            timeEnd: now,
            calendarEventId: 'evt-blocked-tombstone',
            calendarIntegrationId: 'int-1',
            createdTs: now,
            updatedTs: now,
        });

        // The recurring master's routine insert blows up (any per-series failure — E11000, provider
        // hiccup). The batch also carries the unrelated cancelled tombstone.
        const insertSpy = vi.spyOn(routinesDAO, 'insertOne').mockImplementation(async (routine) => {
            throw new Error(`simulated per-series failure for ${routine.calendarEventId}`);
        });
        try {
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
                events: [
                    {
                        id: 'boom-series',
                        title: 'Broken series',
                        timeStart: now,
                        timeEnd: dayjs(now).add(30, 'minute').toISOString(),
                        updated: now,
                        status: 'confirmed' as const,
                        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'],
                    },
                    {
                        id: 'evt-blocked-tombstone',
                        title: 'Cancelled on GCal during the jam',
                        timeStart: now,
                        timeEnd: now,
                        updated: now,
                        status: 'cancelled' as const,
                    },
                ],
                nextSyncToken: 'tok-isolated',
            });
            vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
            vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({
                resourceId: 'res-1',
                expiration: dayjs().add(7, 'day').toISOString(),
            });

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
        } finally {
            insertSpy.mockRestore();
        }

        // The tombstone landed despite the broken series.
        const item = await itemsDAO.findOne({ _id: 'item-blocked-tombstone' });
        expect(item?.status).toBe('trash');
        expect(item?.cancelledByGCal).toBe(true);
        // And the broken series was skipped, not half-imported.
        const boomRoutines = await routinesDAO.findArray({ user: userId, calendarEventId: 'boom-series' });
        expect(boomRoutines).toHaveLength(0);
    });

    // Fix A regression: when duplicate routines linger on the same (user, calendarEventId, integration)
    // triple, an inbound master update must resolve to the LIVE routine — never a dead duplicate. Pre-fix,
    // findExistingRoutineForEvent returned the first arbitrary match, so the update could land on a
    // paused/replaced routine while the active one drifted out of sync.
    it('findExistingRoutineForEvent prefers the active routine when a dead duplicate shares the series', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const sharedEventId = 'shared-master-event';
        const longAgo = dayjs().subtract(30, 'day').toISOString();
        // Dead duplicate: more recently updated than the live one, so a naive "first/most-recent" pick
        // would wrongly choose it. The active filter must override recency.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-dead',
                title: 'Old name',
                active: false,
                calendarEventId: sharedEventId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                updatedTs: dayjs().subtract(1, 'day').toISOString(),
            }),
        );
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-live',
                title: 'Old name',
                active: true,
                calendarEventId: sharedEventId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                updatedTs: longAgo,
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
                    id: sharedEventId,
                    title: 'New name',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-fixA-1',
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // The inbound rename landed on the live routine; the dead duplicate is untouched.
        const live = await routinesDAO.findByOwnerAndId('routine-live', userId);
        const dead = await routinesDAO.findByOwnerAndId('routine-dead', userId);
        expect(live?.title).toBe('New name');
        expect(dead?.title).toBe('Old name');
    });

    it('findExistingRoutineForEvent falls back to most-recently-updated when every match is inactive', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const sharedEventId = 'all-dead-master-event';
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-older',
                title: 'Old name',
                active: false,
                calendarEventId: sharedEventId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                updatedTs: dayjs().subtract(10, 'day').toISOString(),
            }),
        );
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-newer',
                title: 'Old name',
                active: false,
                calendarEventId: sharedEventId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                updatedTs: dayjs().subtract(2, 'day').toISOString(),
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
                    id: sharedEventId,
                    title: 'New name',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-fixA-2',
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // No active routine exists → deterministic fallback to the most-recently-updated dead one.
        const newer = await routinesDAO.findByOwnerAndId('routine-newer', userId);
        const older = await routinesDAO.findByOwnerAndId('routine-older', userId);
        expect(newer?.title).toBe('New name');
        expect(older?.title).toBe('Old name');
        // No third routine was created — the existing match absorbed the update.
        const routines = await routinesDAO.findArray({ user: userId, calendarEventId: sharedEventId });
        expect(routines).toHaveLength(2);
    });

    it('findExistingRoutineForEvent resolves a single matching routine unchanged (regression guard)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const sharedEventId = 'single-master-event';
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-only',
                title: 'Old name',
                active: true,
                calendarEventId: sharedEventId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                updatedTs: dayjs().subtract(30, 'day').toISOString(),
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
                    id: sharedEventId,
                    title: 'New name',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-fixA-3',
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routines = await routinesDAO.findArray({ user: userId, calendarEventId: sharedEventId });
        expect(routines).toHaveLength(1);
        const only = await routinesDAO.findByOwnerAndId('routine-only', userId);
        expect(only?.title).toBe('New name');
    });

    // Fix B2 regression: createRoutineFromGCal races a concurrent webhook that already created the live
    // routine. The unique partial index makes our insert E11000. Pre-fix that threw out of the whole
    // sync; now we re-resolve via findExistingRoutineForEvent and update the race winner — no duplicate,
    // no throw. Mirrors the item-side naked-relink race test above.
    it('createRoutineFromGCal that races an E11000 re-resolves and updates the existing routine (no duplicate, 200)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const sharedEventId = 'race-master-event';
        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. Under TZ=UTC (CI), the old
        // `dayjs().hour(9)` produced 09:00 UTC = 12:00 Jerusalem, so the inferred schedule differed from
        // the stored template → the sync regenerated (churned) items instead of converging. See line ~8817.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();

        // Simulate the concurrent winner: the first time our insert runs for a routine bound to this
        // series, slip a rival active routine into the DB first (so the real insert collides on the
        // uniq_active_routine_per_gcal_series index), then forward to the real insertOne.
        const realInsertOne = routinesDAO.insertOne.bind(routinesDAO);
        let rivalInjected = false;
        vi.spyOn(routinesDAO, 'insertOne').mockImplementation(async (doc, options) => {
            const incoming = doc as Partial<RoutineInterface>;
            if (!rivalInjected && incoming.calendarEventId === sharedEventId && incoming._id !== 'routine-rival') {
                rivalInjected = true;
                await realInsertOne(
                    makeRoutine(userId, {
                        _id: 'routine-rival',
                        title: 'Rival winner',
                        active: true,
                        calendarEventId: sharedEventId,
                        calendarIntegrationId: 'int-1',
                        calendarSyncConfigId: 'sync-config-1',
                        updatedTs: dayjs().subtract(1, 'hour').toISOString(),
                    }),
                );
            }
            return await realInsertOne(doc, options);
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: sharedEventId,
                    title: 'Inbound name',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-race-routine',
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        const warnSpy = vi.spyOn(console, 'warn');

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        // Sync survives the collision — no E11000 escapes.
        expect(res.status).toBe(200);

        // The E11000 catch path actually fired (guards against the test passing for the wrong reason,
        // e.g. if Fix A resolved the rival before reaching createRoutineFromGCal).
        expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('createRoutineFromGCal raced E11000'))).toBe(true);

        // Exactly one routine on the series: the rival winner, updated to the inbound name (not duplicated).
        const routines = await routinesDAO.findArray({ user: userId, calendarEventId: sharedEventId });
        expect(routines).toHaveLength(1);
        const [routine] = routines;
        if (!routine) throw new Error('expected one routine');
        expect(routine._id).toBe('routine-rival');
        expect(routine.title).toBe('Inbound name');
    });

    // Fix B2 safety: a NON-duplicate error from the routine insert must NOT be swallowed by the E11000
    // catch — createRoutineFromGCal re-throws it, so the series is skipped cleanly (no half-import, no
    // silent "recovered" update). Since the per-series isolation wrapper, the throw no longer fails the
    // whole sync (pre-isolation this test asserted a 502): it is logged and the sync completes.
    it('createRoutineFromGCal re-throws a non-duplicate insert error — series skipped, sync completes', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. Under TZ=UTC (CI), the old
        // `dayjs().hour(9)` produced 09:00 UTC = 12:00 Jerusalem, so the inferred schedule differed from
        // the stored template → the sync regenerated (churned) items instead of converging. See line ~8817.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();
        // Non-E11000 failure on the create insert.
        vi.spyOn(routinesDAO, 'insertOne').mockRejectedValueOnce(new Error('mongo blip — not a duplicate key'));

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'non-dup-error-event',
                    title: 'Will fail',
                    timeStart: tomorrowAt9,
                    timeEnd: dayjs(tomorrowAt9).add(30, 'minute').toISOString(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
                },
            ],
            nextSyncToken: 'tok-nondup',
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);

        // The non-duplicate error escapes createRoutineFromGCal (NOT swallowed by the E11000-only
        // catch — no bogus "recovered" update ran) and is contained by the per-series isolation
        // wrapper: logged, series skipped, sync completes.
        const errorSpy = vi.spyOn(console, 'error');
        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);
        expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('recurring-master import failed'))).toBe(true);
        // Nothing half-imported for the failed series.
        const failedSeriesRoutines = await routinesDAO.findArray({ user: userId, calendarEventId: 'non-dup-error-event' });
        expect(failedSeriesRoutines).toHaveLength(0);
    });

    it('importCalendarEvents normalizes a suffixed recurringEventId on an instance so it is filtered as a series instance (not upserted as a standalone item)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const bareMasterId = 'mleem99efhim4a0tsh3s86797o';
        const suffixedMasterId = `${bareMasterId}_R20260519T123000`;
        // Construct tomorrow at 09:00 in the sync config's timezone (Asia/Jerusalem) — NOT the server's
        // local tz — so `extractLocalTime` round-trips the inbound master's start to exactly "09:00",
        // matching makeRoutine's `calendarItemTemplate.timeOfDay`. Under TZ=UTC (CI), the old
        // `dayjs().hour(9)` produced 09:00 UTC = 12:00 Jerusalem, so the inferred schedule differed from
        // the stored template → the sync regenerated (churned) items instead of converging. See line ~8817.
        const tomorrowAt9 = dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();
        const tomorrowAt930 = dayjs(tomorrowAt9).add(30, 'minute').toISOString();

        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-bare-2',
                calendarEventId: bareMasterId,
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'cfg-1',
            }),
        );

        // Inbound: one instance event whose recurringEventId carries the rebased-master suffix.
        // Pre-fix, this was treated as a standalone event (not a series instance) and upserted as
        // a duplicate item alongside the routine-generated one.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: `${bareMasterId}_20260518T060000Z`,
                    title: 'Standup',
                    timeStart: tomorrowAt9,
                    timeEnd: tomorrowAt930,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurringEventId: suffixedMasterId,
                },
            ],
            nextSyncToken: 'tok-instance',
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // No standalone item should be upserted — the routine generator owns the series instances.
        const standaloneItems = await itemsDAO.findArray({ user: userId, calendarEventId: `${bareMasterId}_20260518T060000Z` } as never);
        expect(standaloneItems).toHaveLength(0);
    });

    it('revive clears a prior cancelledByGCal: true (restored item carries no phantom badge)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const past = dayjs().subtract(1, 'hour').toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        // Item was previously cancelled by GCal — trashed locally and stamped.
        await itemsDAO.insertOne({
            _id: 'item-revive-clear-flag',
            user: userId,
            status: 'trash',
            title: 'Was cancelled',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-revive-clear-flag',
            calendarIntegrationId: 'int-1',
            cancelledByGCal: true,
            createdTs: past,
            updatedTs: past,
            lastSyncedFromGCalTs: past,
        });

        // GCal re-emits the event as confirmed (e.g. user un-cancelled it on the GCal side).
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-revive-clear-flag',
                    title: 'Was cancelled',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-revive-clear-flag' });
        expect(item?.status).toBe('calendar');
        expect(item?.cancelledByGCal).toBeUndefined();
    });

    it('allDay: true → false transition strips the stale flag from the local item', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const localAnchor = dayjs().subtract(1, 'hour').toISOString();
        const eventUpdated = dayjs().toISOString();
        const startDate = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const endDate = dayjs().add(2, 'day').format('YYYY-MM-DD');
        // Local item was previously all-day.
        await itemsDAO.insertOne({
            _id: 'item-allday-flip',
            user: userId,
            status: 'calendar',
            title: 'Was all day',
            allDay: true,
            timeStart: startDate,
            timeEnd: endDate,
            calendarEventId: 'evt-allday-flip',
            calendarIntegrationId: 'int-1',
            createdTs: localAnchor,
            updatedTs: localAnchor,
            lastSyncedFromGCalTs: localAnchor,
        });

        // GCal now returns the event as timed (allDay: false / absent).
        const timedStart = dayjs().add(1, 'day').toISOString();
        const timedEnd = dayjs(timedStart).add(1, 'hour').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-allday-flip',
                    title: 'Now timed',
                    timeStart: timedStart,
                    timeEnd: timedEnd,
                    updated: eventUpdated,
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-allday-flip' });
        expect(item?.allDay).toBeUndefined();
        expect(item?.timeStart).toBe(timedStart);
        expect(item?.timeEnd).toBe(timedEnd);
    });

    it('GCal-older payload changing only responseStatus still falls through and overwrites', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const eventUpdated = dayjs().subtract(2, 'hour').toISOString();
        const localAnchor = dayjs().toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-responsestatus-only',
            user: userId,
            status: 'calendar',
            title: 'Meeting',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-responsestatus-only',
            calendarIntegrationId: 'int-1',
            attendees: [{ email: 'alice@example.com', responseStatus: 'needsAction', self: true }],
            responseStatus: 'needsAction',
            createdTs: eventUpdated,
            updatedTs: localAnchor,
            lastSyncedFromGCalTs: localAnchor,
        });

        // GCal payload is older but reports a fresher RSVP on the self attendee.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-responsestatus-only',
                    title: 'Meeting',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: eventUpdated,
                    status: 'confirmed',
                    attendees: [{ email: 'alice@example.com', responseStatus: 'accepted', self: true }],
                    responseStatus: 'accepted',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-responsestatus-only' });
        // Title (structural, older payload) preserved; responseStatus (GCal-owned) overwritten.
        expect(item?.title).toBe('Meeting');
        expect(item?.responseStatus).toBe('accepted');
        const acceptedAttendee = item?.attendees?.find((a) => a.self);
        expect(acceptedAttendee?.responseStatus).toBe('accepted');
    });

    it('GCal-owned routine delta from an older webhook stamps updatedTs at sync time, not the backwards event.updated', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Routine last synced from GCal at gcalAnchor; local updatedTs is newer (T2). The webhook
        // replays an OLDER master (event.updated < gcalAnchor) carrying only an attendee delta →
        // the GCal-owned-only fast-path. Pre-fix it stamped `updatedTs: event.updated` — a
        // backwards move that every other device's `<=` LWW gate rejects, so the fanned-out op
        // silently diverged. The row must instead advance to the sync clock.
        const olderEventUpdated = '2025-12-31T00:00:00.000Z';
        const gcalAnchor = '2026-01-01T00:00:00.000Z';
        const localUpdatedTs = '2026-02-01T00:00:00.000Z';
        // 09:00 Jerusalem / 30-minute duration → matches makeRoutine's default template (no structural diff).
        const masterTimeStart = '2025-06-09T09:00:00+03:00';
        const masterTimeEnd = '2025-06-09T09:30:00+03:00';
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-gcal-owned-delta',
                calendarEventId: 'gcal-master-owned-delta',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
                lastSyncedFromGCalTs: gcalAnchor,
                updatedTs: localUpdatedTs,
                attendees: [{ email: 'stale@example.com', responseStatus: 'needsAction' }],
            }),
        );

        const masterEvent = {
            id: 'gcal-master-owned-delta',
            title: 'Standup',
            timeStart: masterTimeStart,
            timeEnd: masterTimeEnd,
            updated: olderEventUpdated,
            status: 'confirmed' as const,
            recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
            attendees: [{ email: 'fresh@example.com', responseStatus: 'accepted' }],
        };
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [masterEvent], nextSyncToken: 'tok-owned-delta' });

        const beforeSync = dayjs().toISOString();
        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findByOwnerAndId('routine-gcal-owned-delta', userId);
        // GCal-owned delta applied…
        expect(routine?.attendees).toEqual([{ email: 'fresh@example.com', responseStatus: 'accepted' }]);
        // …with updatedTs advanced to the sync clock — never moved backwards to event.updated.
        // (This is the one assertion that discriminates the fix; the rest of the test is a
        // forward-guard on surrounding invariants.)
        expect(dayjs(routine?.updatedTs).isBefore(beforeSync)).toBe(false);
        // The GCal-side anchor is untouched by this fast-path.
        expect(routine?.lastSyncedFromGCalTs).toBe(gcalAnchor);
        // The fanned-out op snapshot matches the stored row, so other devices' LWW gates accept it.
        const ops = await operationsDAO.findArray({ entityId: 'routine-gcal-owned-delta', entityType: 'routine' });
        expect(ops).toHaveLength(1);
        const [op] = ops;
        if (!op) throw new Error('expected one routine op');
        expect((op.snapshot as RoutineInterface).updatedTs).toBe(routine?.updatedTs);

        // No lock-out (forward-guard, invariant under the stamp change): a later structural
        // webhook whose event.updated is newer than the anchor (but older than the ctx.now just
        // stamped) still applies, because the structural gate compares against
        // lastSyncedFromGCalTs, not updatedTs.
        const structuralEventUpdated = '2026-03-01T00:00:00.000Z';
        // The first sync stored a syncToken, so the second sync takes the incremental path.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue({
            events: [{ ...masterEvent, title: 'Standup renamed', updated: structuralEventUpdated }],
            nextSyncToken: 'tok-owned-delta-2',
        });
        const res2 = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res2.status).toBe(200);
        const renamed = await routinesDAO.findByOwnerAndId('routine-gcal-owned-delta', userId);
        expect(renamed?.title).toBe('Standup renamed');
    });
});
