/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import dayjs from 'dayjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import { db } from '../loaders/mainLoader.js';
import type { ItemInterface } from '../types/entities.js';
import { app, getUserId, insertIntegrationWithConfig, loginAsAlice, useCalendarTestLifecycle } from './calendarTestKit.js';
import { authenticatedRequest } from './helpers.js';

useCalendarTestLifecycle();

// ─── upsertCalendarItem (via sync) ─────────────────────────────────────────

describe('POST /calendar/integrations/:id/sync — upsert paths', () => {
    beforeEach(() => {
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
    });

    it('updates an existing item when GCal event is newer', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        const newUpdatedTs = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-upd',
            user: userId,
            status: 'calendar',
            title: 'Old title',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-upd',
            calendarIntegrationId: 'int-1',
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-upd', title: 'New title', timeStart: futureTs, timeEnd: futureTs, updated: newUpdatedTs, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-upd' });
        expect(item?.title).toBe('New title');
    });

    it('on a concurrent-create race for a new event, merges into the winner instead of duplicating (E11000 catch)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const futureTs = dayjs().add(1, 'day').toISOString();
        const gcalUpdated = dayjs().toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-race', title: 'Raced event', timeStart: futureTs, timeEnd: futureTs, updated: gcalUpdated, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        // Simulate a rival inbound sync that wins the create: when createNewCalendarItem's insert fires,
        // first insert a live calendar item carrying the same calendarEventId, then run the real insert
        // (which now collides on uniq_calendar_item_per_event and throws E11000). The catch must
        // re-resolve to the rival's row and merge, leaving exactly one live item.
        const realInsertOne = itemsDAO.insertOne.bind(itemsDAO);
        let rivalInserted = false;
        vi.spyOn(itemsDAO, 'insertOne').mockImplementation(async (doc) => {
            const candidate = doc as ItemInterface;
            if (!rivalInserted && candidate.calendarEventId === 'evt-race' && candidate.status === 'calendar') {
                rivalInserted = true;
                await realInsertOne({ ...candidate, _id: 'item-race-rival' });
            }
            return realInsertOne(doc);
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const live = await itemsDAO.findArray({ user: userId, calendarEventId: 'evt-race', status: 'calendar' });
        expect(live).toHaveLength(1);
        const [winner] = live;
        if (!winner) throw new Error('expected the rival-bound item to survive');
        expect(winner._id).toBe('item-race-rival');
    });

    it('a trashed twin sharing the event id is revived in place — no duplicate live item, index stays buildable', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const futureTs = dayjs().add(1, 'day').toISOString();
        const gcalUpdated = dayjs().toISOString();
        // A trashed twin (prior cancel) keeps its calendarEventId for revive — it sits OUTSIDE the
        // status:'calendar' unique index. When the event comes back, upsertCalendarItem must REVIVE that
        // row (status→calendar), not create a second live row. This is the scenario that proves the
        // status-scoped index design: a trashed twin and a live row can coexist without an E11000, and
        // the inbound event converges to exactly one live item.
        await itemsDAO.insertOne({
            _id: 'item-dead-twin',
            user: userId,
            status: 'trash',
            title: 'Old cancelled',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-twin',
            calendarIntegrationId: 'int-1',
            createdTs: gcalUpdated,
            updatedTs: dayjs().subtract(1, 'hour').toISOString(),
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-twin', title: 'Live again', timeStart: futureTs, timeEnd: futureTs, updated: gcalUpdated, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // Exactly one live item, and it's the revived twin (not a fresh duplicate).
        const live = await itemsDAO.findArray({ user: userId, calendarEventId: 'evt-twin', status: 'calendar' });
        expect(live).toHaveLength(1);
        const [winner] = live;
        if (!winner) throw new Error('expected the revived twin to be live');
        expect(winner._id).toBe('item-dead-twin');
        expect(winner.title).toBe('Live again');
    });

    it('skips a new past event from Google (no local item created)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const pastTime = dayjs().subtract(2, 'day').toISOString();
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-past-new', title: 'Past meeting', timeStart: pastTime, timeEnd: pastTime, updated: pastTime, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ calendarEventId: 'evt-past-new' });
        expect(item).toBeNull();
    });

    it("syncs (not trashes) an existing 'calendar' item moved to a date before today", async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const createdTime = dayjs().subtract(2, 'day').toISOString();
        const futureTime = dayjs().add(1, 'day').toISOString();
        const pastTime = dayjs().subtract(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-moved-past',
            user: userId,
            status: 'calendar',
            title: 'Was future',
            timeStart: futureTime,
            timeEnd: futureTime,
            calendarEventId: 'evt-moved',
            calendarIntegrationId: 'int-1',
            createdTs: createdTime,
            updatedTs: createdTime,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-moved', title: 'Now past', timeStart: pastTime, timeEnd: pastTime, updated: dayjs().toISOString(), status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        // An existing item rescheduled backwards is synced wherever it lands — kept live, new time + title applied.
        const item = await itemsDAO.findOne({ _id: 'item-moved-past' });
        expect(item?.status).toBe('calendar');
        expect(item?.title).toBe('Now past');
        expect(item?.timeStart).toBe(pastTime);
        // A user-driven backward drag must never masquerade as a GCal cancellation.
        expect(item?.cancelledByGCal).toBeUndefined();
    });

    it('applies a backward move even when the item carries a lastSyncedFromGCalTs anchor', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // The structurally-newer guard compares event.updated against the item's lastSyncedFromGCalTs.
        // A real inbound backward move carries an event.updated newer than the last applied payload —
        // assert that gate doesn't block the move when an anchor is present (regression for the
        // no-op-on-existing-anchor edge the past-event trash removal could otherwise hide).
        const anchorTs = dayjs().subtract(2, 'hour').toISOString();
        const eventUpdatedTs = dayjs().toISOString();
        const futureTime = dayjs().add(1, 'day').toISOString();
        const pastTime = dayjs().subtract(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-moved-past-anchored',
            user: userId,
            status: 'calendar',
            title: 'Was future',
            timeStart: futureTime,
            timeEnd: futureTime,
            calendarEventId: 'evt-moved-anchored',
            calendarIntegrationId: 'int-1',
            lastSyncedFromGCalTs: anchorTs,
            createdTs: anchorTs,
            updatedTs: anchorTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-moved-anchored', title: 'Now past', timeStart: pastTime, timeEnd: pastTime, updated: eventUpdatedTs, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-moved-past-anchored' });
        expect(item?.status).toBe('calendar');
        expect(item?.title).toBe('Now past');
        expect(item?.timeStart).toBe(pastTime);
    });

    it('updates (not trashes) an in-progress event whose start is past but end is future', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const startTime = dayjs().subtract(1, 'hour').toISOString();
        const endTime = dayjs().add(1, 'hour').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-in-progress',
            user: userId,
            status: 'calendar',
            title: 'In-progress meeting',
            timeStart: startTime,
            timeEnd: endTime,
            calendarEventId: 'evt-in-progress',
            calendarIntegrationId: 'int-1',
            createdTs: startTime,
            updatedTs: startTime,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-in-progress',
                    title: 'In-progress meeting (edited)',
                    timeStart: startTime,
                    timeEnd: endTime,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    description: 'new notes',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-in-progress' });
        expect(item?.status).toBe('calendar');
        expect(item?.title).toBe('In-progress meeting (edited)');
    });

    it('skips a routine-managed item when its GCal event is moved to the past', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const futureTime = dayjs().add(1, 'day').toISOString();
        const pastTime = dayjs().subtract(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-routine-past',
            user: userId,
            status: 'calendar',
            title: 'Routine item',
            timeStart: futureTime,
            timeEnd: futureTime,
            calendarEventId: 'evt-routine-past',
            calendarIntegrationId: 'int-1',
            routineId: 'routine-1',
            createdTs: futureTime,
            updatedTs: futureTime,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-routine-past',
                    title: 'Routine item',
                    timeStart: pastTime,
                    timeEnd: pastTime,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-routine-past' });
        // Routine-managed items must not be trashed by the past-event filter.
        expect(item?.status).toBe('calendar');
    });

    it('creates a new item for an event earlier today', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // The seam under test: `isPastEvent` keys on timeEnd against start-of-today in the *config's*
        // tz (Asia/Jerusalem, per makeSyncConfig) — so an event that already ENDED must still import
        // as long as it ended after that cutoff. Pin the clock rather than deriving the window from
        // the runner's local start-of-day: that made this fail on a UTC runner between 21:00Z-23:59Z,
        // where JLM has rolled to tomorrow and the cutoff jumps forward to 21:00Z today.
        // Frozen at Apr 25 12:00 UTC = 15:00 JLM. Cutoff = Apr 24 21:00 UTC. Event 09:00-10:00 UTC:
        // ended, but comfortably after the cutoff.
        const baseDay = dayjs.utc('2026-04-25T00:00:00Z');
        vi.useFakeTimers();
        vi.setSystemTime(baseDay.add(12, 'hour').toDate());
        try {
            const earlierTodayStart = baseDay.add(9, 'hour').toISOString();
            const earlierTodayEnd = baseDay.add(10, 'hour').toISOString();
            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
                events: [
                    {
                        id: 'evt-earlier-today',
                        title: 'Earlier today',
                        timeStart: earlierTodayStart,
                        timeEnd: earlierTodayEnd,
                        updated: dayjs().toISOString(),
                        status: 'confirmed',
                    },
                ],
                nextSyncToken: 'tok-1',
            });

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);

            const item = await itemsDAO.findOne({ calendarEventId: 'evt-earlier-today' });
            expect(item?.status).toBe('calendar');
            expect(item?.title).toBe('Earlier today');
            expect(item?.timeEnd).toBe(earlierTodayEnd); // proves the ended-today event imported intact
        } finally {
            vi.useRealTimers();
        }
    });

    it('updates an existing item moved from later today to earlier today', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Pin the clock: derived from the runner's local start-of-day, the "earlier" window landed
        // *past* the Asia/Jerusalem cutoff on a UTC runner at 21:00Z-23:59Z. That never failed —
        // `applyPastEventToExisting` funnels into the same `updateExistingCalendarItem` call as the
        // live branch, so the assertions held while the test silently exercised the moved-into-the-past
        // path instead of the intended one. Freezing "now" keeps it on the branch it names.
        // Frozen at Apr 25 12:00 UTC = 15:00 JLM; both windows below stay ahead of that.
        const baseDay = dayjs.utc('2026-04-25T00:00:00Z');
        vi.useFakeTimers();
        vi.setSystemTime(baseDay.add(12, 'hour').toDate());
        try {
            const laterTodayStart = baseDay.add(20, 'hour').toISOString();
            const laterTodayEnd = baseDay.add(21, 'hour').toISOString();
            const earlierTodayStart = baseDay.add(16, 'hour').toISOString();
            const earlierTodayEnd = baseDay.add(17, 'hour').toISOString();
            const createdTime = dayjs().subtract(2, 'day').toISOString();
            await itemsDAO.insertOne({
                _id: 'item-moved-earlier-today',
                user: userId,
                status: 'calendar',
                title: 'Late today',
                timeStart: laterTodayStart,
                timeEnd: laterTodayEnd,
                calendarEventId: 'evt-moved-earlier-today',
                calendarIntegrationId: 'int-1',
                createdTs: createdTime,
                updatedTs: createdTime,
            });

            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
                events: [
                    {
                        id: 'evt-moved-earlier-today',
                        title: 'Moved earlier',
                        timeStart: earlierTodayStart,
                        timeEnd: earlierTodayEnd,
                        updated: dayjs().toISOString(),
                        status: 'confirmed',
                    },
                ],
                nextSyncToken: 'tok-1',
            });

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);

            const item = await itemsDAO.findOne({ _id: 'item-moved-earlier-today' });
            expect(item?.status).toBe('calendar');
            expect(item?.title).toBe('Moved earlier');
            expect(item?.timeStart).toBe(earlierTodayStart);
        } finally {
            vi.useRealTimers();
        }
    });

    it('leaves an already-trashed item alone when event remains in past', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const trashedTs = dayjs().subtract(1, 'day').toISOString();
        const pastStart = dayjs().subtract(2, 'day').toISOString();
        const pastEnd = dayjs().subtract(2, 'day').add(1, 'hour').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-already-trashed',
            user: userId,
            status: 'trash',
            title: 'Already trashed',
            timeStart: pastStart,
            timeEnd: pastEnd,
            calendarEventId: 'evt-already-trashed',
            calendarIntegrationId: 'int-1',
            createdTs: trashedTs,
            updatedTs: trashedTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-already-trashed', title: 'Still past', timeStart: pastStart, timeEnd: pastEnd, updated: trashedTs, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-already-trashed' });
        expect(item?.status).toBe('trash');
        // updatedTs unchanged proves the trash branch short-circuited (no operation written).
        expect(item?.updatedTs).toBe(trashedTs);
    });

    it('honors calendar timeZone for the today cutoff', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // April 2026 is DST in Asia/Jerusalem (UTC+3). Freeze "now" at 22:30 UTC on April 25.
        // In JLM that's April 26 01:30 — already "tomorrow". start-of-today JLM = April 26 00:00 JLM = April 25 21:00 UTC.
        // start-of-today UTC = April 25 00:00 UTC. The cutoffs disagree by 21h.
        // An event ending at April 25 20:30 UTC is *before* the JLM cutoff (past in JLM)
        // but *after* the UTC cutoff (today in UTC). A *new* (no local item) past event is ignored,
        // so a TZ-aware sync creates nothing; a UTC-only sync would treat it as today and create the item.
        const baseDay = dayjs.utc('2026-04-25T00:00:00Z');
        vi.useFakeTimers();
        vi.setSystemTime(baseDay.add(22, 'hour').add(30, 'minute').toDate());
        try {
            const eventStart = baseDay.add(20, 'hour').toISOString();
            const eventEnd = baseDay.add(20, 'hour').add(30, 'minute').toISOString();

            vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
                events: [
                    {
                        id: 'evt-tz-borderline',
                        title: 'Borderline',
                        timeStart: eventStart,
                        timeEnd: eventEnd,
                        updated: dayjs().toISOString(),
                        status: 'confirmed',
                    },
                ],
                nextSyncToken: 'tok-1',
            });

            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);

            // The mock returns the event unconditionally (bypassing GCal's own timeMin), so this
            // asserts the in-process cutoff specifically: past in JLM → ignored, no item created.
            // A UTC-only cutoff would classify it as today and import it.
            const item = await itemsDAO.findOne({ calendarEventId: 'evt-tz-borderline' });
            expect(item).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('updates a reclassified nextAction item when its GCal event is moved to past', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // User reclassified the calendar item as a nextAction. Past-event branch must preserve it
        // (not trash it) and still apply title/time edits from GCal — otherwise users lose work.
        const createdTs = dayjs().subtract(2, 'day').toISOString();
        const futureTime = dayjs().add(1, 'day').toISOString();
        const pastTime = dayjs().subtract(2, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-reclassified-past',
            user: userId,
            status: 'nextAction',
            title: 'Original',
            timeStart: futureTime,
            timeEnd: futureTime,
            calendarEventId: 'evt-reclassified-past',
            calendarIntegrationId: 'int-1',
            createdTs,
            updatedTs: createdTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-reclassified-past',
                    title: 'Edited title',
                    timeStart: pastTime,
                    timeEnd: pastTime,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-reclassified-past' });
        expect(item?.status).toBe('nextAction');
        expect(item?.title).toBe('Edited title');
    });

    it('passes start-of-today (in calendar timeZone) as timeMin on full sync', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const fullSyncSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        expect(fullSyncSpy).toHaveBeenCalledTimes(1);
        const [, timeMinArg] = fullSyncSpy.mock.calls[0]!;
        // timeMin must be 00:00 (start of day) when projected into the calendar's TZ.
        expect(dayjs(timeMinArg).tz('Asia/Jerusalem').format('HH:mm:ss')).toBe('00:00:00');
    });

    it('skips update when local item is newer than the GCal event', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const localTs = dayjs().toISOString();
        const gcalTs = dayjs().subtract(1, 'hour').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-stale',
            user: userId,
            status: 'calendar',
            title: 'Local edit',
            timeStart: localTs,
            timeEnd: localTs,
            calendarEventId: 'evt-stale',
            calendarIntegrationId: 'int-1',
            createdTs: gcalTs,
            updatedTs: localTs,
            // Anchor against which the inbound guard compares — without this the empty-string
            // fallback would let the older GCal payload through.
            lastSyncedFromGCalTs: localTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-stale', title: 'Overwritten title', timeStart: gcalTs, timeEnd: gcalTs, updated: gcalTs, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-stale' });
        // Local edit must be preserved — GCal event is older than local updatedTs.
        expect(item?.title).toBe('Local edit');
    });

    it('rejects an old GCal payload when lastSyncedFromGCalTs is set', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const t1 = dayjs().subtract(1, 'hour').toISOString(); // older inbound
        const t2 = dayjs().toISOString(); // last applied inbound
        await itemsDAO.insertOne({
            _id: 'item-stale-anchor',
            user: userId,
            status: 'calendar',
            title: 'Title from t2',
            timeStart: t2,
            timeEnd: t2,
            calendarEventId: 'evt-stale-anchor',
            calendarIntegrationId: 'int-1',
            createdTs: t1,
            // updatedTs older than t1 — proves the guard uses lastSyncedFromGCalTs, not updatedTs.
            updatedTs: dayjs().subtract(2, 'hour').toISOString(),
            lastSyncedFromGCalTs: t2,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-stale-anchor', title: 'Stale redelivery', timeStart: t1, timeEnd: t1, updated: t1, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-stale-anchor' });
        expect(item?.title).toBe('Title from t2');
    });

    it('advances the anchor without recording an op when GCal updated advances but content is identical', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Reproduces the staging notification storm: GCal bumps event.updated for a non-synced
        // reason (reminders/ACL/our own done-marker echo) while title/time are byte-identical.
        // Pre-fix this re-applied a full replaceById + op on every webhook fire → a web push each
        // time. Post-fix it advances lastSyncedFromGCalTs silently — no op, no updatedTs bump.
        const t1 = dayjs().subtract(1, 'hour').toISOString(); // last applied inbound (anchor)
        const t2 = dayjs().toISOString(); // newer event.updated, same content
        const start = dayjs().add(1, 'day').toISOString();
        const end = dayjs().add(1, 'day').add(30, 'minute').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-noop',
            user: userId,
            status: 'calendar',
            title: 'Stable title',
            timeStart: start,
            timeEnd: end,
            calendarEventId: 'evt-noop',
            calendarIntegrationId: 'int-1',
            createdTs: t1,
            updatedTs: t1,
            lastSyncedFromGCalTs: t1,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            // Identical title/time/allDay; only `updated` advanced.
            events: [{ id: 'evt-noop', title: 'Stable title', timeStart: start, timeEnd: end, updated: t2, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-noop' });
        // Anchor advanced so the next fire short-circuits at the "not newer" guard.
        expect(item?.lastSyncedFromGCalTs).toBe(t2);
        // updatedTs (the LWW anchor) must NOT move — this is a silent re-anchor, not a user-visible edit.
        expect(item?.updatedTs).toBe(t1);
        // Crucially: no operation recorded → no web push fans out for a content no-op.
        const ops = await db.collection('operations').find({ user: userId, entityId: 'item-noop' }).toArray();
        expect(ops).toHaveLength(0);
    });

    it('still records an op when the GCal payload is newer AND a structural field changed', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Boundary opposite of the content-noop case: same advancing `updated`, but the title
        // actually changed. The noop short-circuit must NOT engage — a real edit has to apply,
        // record an op, and bump updatedTs so other devices and live tabs converge.
        const t1 = dayjs().subtract(1, 'hour').toISOString();
        const t2 = dayjs().toISOString();
        const start = dayjs().add(1, 'day').toISOString();
        const end = dayjs().add(1, 'day').add(30, 'minute').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-real-edit',
            user: userId,
            status: 'calendar',
            title: 'Original title',
            timeStart: start,
            timeEnd: end,
            calendarEventId: 'evt-real-edit',
            calendarIntegrationId: 'int-1',
            createdTs: t1,
            updatedTs: t1,
            lastSyncedFromGCalTs: t1,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-real-edit', title: 'Renamed in GCal', timeStart: start, timeEnd: end, updated: t2, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-real-edit' });
        expect(item?.title).toBe('Renamed in GCal');
        expect(item?.lastSyncedFromGCalTs).toBe(t2);
        const ops = await db.collection('operations').find({ user: userId, entityId: 'item-real-edit' }).toArray();
        expect(ops).toHaveLength(1);
    });

    it('revives a trashed item when its GCal event becomes confirmed again', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Reproduces the bug: trashed by a prior disconnect, local updatedTs later than the
        // GCal event.updated. Pre-fix the structural-newer guard would skip; the revive branch
        // must restore to status: 'calendar' regardless.
        const eventUpdated = dayjs().subtract(1, 'hour').toISOString();
        const trashedTs = dayjs().toISOString();
        const futureStart = dayjs().add(1, 'day').toISOString();
        const futureEnd = dayjs().add(1, 'day').add(30, 'minute').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-revive',
            user: userId,
            status: 'trash',
            title: 'Old title',
            timeStart: futureStart,
            timeEnd: futureStart,
            calendarEventId: 'evt-revive',
            calendarIntegrationId: 'int-1',
            createdTs: eventUpdated,
            updatedTs: trashedTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-revive',
                    title: 'Cross-account smoke (moved)',
                    timeStart: futureStart,
                    timeEnd: futureEnd,
                    updated: eventUpdated,
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-revive' });
        expect(item?.status).toBe('calendar');
        expect(item?.title).toBe('Cross-account smoke (moved)');
        expect(item?.timeEnd).toBe(futureEnd);
        expect(item?.lastSyncedFromGCalTs).toBe(eventUpdated);

        // An update operation must be recorded so other devices learn about the revive.
        const ops = await db.collection('operations').find({ user: userId, entityId: 'item-revive' }).toArray();
        const reviveOp = ops.find((o) => o.opType === 'update');
        expect(reviveOp).toBeDefined();
    });

    it('does not revive a trashed item if the resurrected event is in the past', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Past-event short-circuit must run before the revive branch.
        const eventUpdated = dayjs().subtract(1, 'hour').toISOString();
        const trashedTs = dayjs().toISOString();
        const pastStart = dayjs().subtract(2, 'day').toISOString();
        const pastEnd = dayjs().subtract(2, 'day').add(30, 'minute').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-past-revive',
            user: userId,
            status: 'trash',
            title: 'Old title',
            timeStart: pastStart,
            timeEnd: pastStart,
            calendarEventId: 'evt-past-revive',
            calendarIntegrationId: 'int-1',
            createdTs: eventUpdated,
            updatedTs: trashedTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-past-revive', title: 'Past event', timeStart: pastStart, timeEnd: pastEnd, updated: eventUpdated, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-past-revive' });
        expect(item?.status).toBe('trash');
        expect(item?.title).toBe('Old title');
    });

    it('does not revive a routine-managed trashed item', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const eventUpdated = dayjs().subtract(1, 'hour').toISOString();
        const trashedTs = dayjs().toISOString();
        const futureStart = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-routine-revive',
            user: userId,
            status: 'trash',
            title: 'Routine instance',
            routineId: 'routine-1',
            timeStart: futureStart,
            timeEnd: futureStart,
            calendarEventId: 'evt-routine-revive',
            calendarIntegrationId: 'int-1',
            createdTs: eventUpdated,
            updatedTs: trashedTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-routine-revive',
                    title: 'Should not revive',
                    timeStart: futureStart,
                    timeEnd: futureStart,
                    updated: eventUpdated,
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-routine-revive' });
        expect(item?.status).toBe('trash');
        expect(item?.title).toBe('Routine instance');
    });

    it('on revive, GCal description overwrites stale local notes (last-write-wins anchor on revive is epoch)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const eventUpdated = dayjs().subtract(1, 'hour').toISOString();
        const trashedTs = dayjs().toISOString();
        const futureStart = dayjs().add(1, 'day').toISOString();
        const futureEnd = dayjs().add(1, 'day').add(30, 'minute').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-revive-notes',
            user: userId,
            status: 'trash',
            title: 'Old title',
            timeStart: futureStart,
            timeEnd: futureStart,
            calendarEventId: 'evt-revive-notes',
            calendarIntegrationId: 'int-1',
            notes: 'old notes',
            lastSyncedNotes: '<p>old notes</p>',
            createdTs: eventUpdated,
            // Trash stamp later than event.updated — pre-fix this would have made GCal lose
            // the last-write-wins comparison via `dayjs('').unix() === NaN` (which always
            // returns false). Anchored at epoch on revive, GCal correctly wins.
            updatedTs: trashedTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-revive-notes',
                    title: 'Revived',
                    timeStart: futureStart,
                    timeEnd: futureEnd,
                    updated: eventUpdated,
                    status: 'confirmed',
                    description: '<p>fresh notes from gcal</p>',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-revive-notes' });
        expect(item?.status).toBe('calendar');
        expect(item?.notes).toBe('fresh notes from gcal');
        expect(item?.lastSyncedNotes).toBe('<p>fresh notes from gcal</p>');
    });

    it('does not regress lastSyncedFromGCalTs on a notes-only update from an out-of-order webhook', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Existing item with anchor T3 but a much older local updatedTs T1. An out-of-order
        // webhook arrives with event.updated = T2 (between T1 and T3) and a changed description:
        //   - Notes guard (`resolveInboundNotes` compares gcalUpdated vs updatedTs): T2 > T1 → notes apply.
        //   - Structural-newer guard (compares gcalUpdated vs lastSyncedFromGCalTs): T2 < T3 → no structural change.
        //   - Anchor must stay at T3 — bumping to T2 would let an even-older payload pass the guard later.
        const t1 = dayjs().subtract(2, 'hour').toISOString();
        const t2 = dayjs().subtract(1, 'hour').toISOString();
        const t3 = dayjs().toISOString();
        const futureStart = dayjs().add(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: 'item-anchor-no-regress',
            user: userId,
            status: 'calendar',
            title: 'Title at T3',
            timeStart: futureStart,
            timeEnd: futureStart,
            calendarEventId: 'evt-anchor-no-regress',
            calendarIntegrationId: 'int-1',
            lastSyncedNotes: '<p>old desc</p>',
            createdTs: t1,
            updatedTs: t1,
            lastSyncedFromGCalTs: t3,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-anchor-no-regress',
                    title: 'Stale title (should be ignored)',
                    timeStart: futureStart,
                    timeEnd: futureStart,
                    updated: t2,
                    status: 'confirmed',
                    description: '<p>new desc</p>',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-anchor-no-regress' });
        // Notes update applied (GCal changed the description), structural fields stayed put.
        expect(item?.title).toBe('Title at T3');
        expect(item?.notes).toBe('new desc');
        // Anchor must NOT regress to T2 — that would let an even-older T1 payload pass the guard.
        expect(item?.lastSyncedFromGCalTs).toBe(t3);
    });

    it('strips leading "✓ " from inbound title when local item is already done', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        const newUpdatedTs = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-done-strip',
            user: userId,
            status: 'done',
            title: 'Verify done sync',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-done-strip',
            calendarIntegrationId: 'int-1',
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-done-strip', title: '✓ Foo', timeStart: futureTs, timeEnd: futureTs, updated: newUpdatedTs, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-done-strip' });
        expect(item?.title).toBe('Foo');
    });

    it('preserves a literal "✓ " prefix in inbound title when local item is open (status: calendar)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const oldTs = dayjs().subtract(1, 'hour').toISOString();
        const futureTs = dayjs().add(1, 'day').toISOString();
        const newUpdatedTs = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-open-keep',
            user: userId,
            status: 'calendar',
            title: 'Original',
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: 'evt-open-keep',
            calendarIntegrationId: 'int-1',
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [{ id: 'evt-open-keep', title: '✓ Foo', timeStart: futureTs, timeEnd: futureTs, updated: newUpdatedTs, status: 'confirmed' }],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-open-keep' });
        expect(item?.title).toBe('✓ Foo');
    });
});

// ─── Full-sync reconciliation sweep (self-healing of missed deletions) ──────
//
// A single (non-recurring) GCal event that is hard-deleted while sync is down (expired syncToken,
// disconnected integration, or the event aged past timeMin before a post-deletion delta arrived)
// never delivers a `cancelled` tombstone — so the reactive trash path in upsertCalendarItem can
// never fire. The full-sync reconciliation sweep heals this: it trashes any in-window calendar item
// whose calendarEventId is absent from the authoritative full-sync snapshot. The sweep MUST run only
// on full syncs (incremental deltas are not snapshots), must stay window-bounded, and must shield
// items whose create/update may still be propagating to GCal's index.
describe('POST /calendar/integrations/:id/sync — full-sync reconciliation sweep', () => {
    beforeEach(() => {
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
    });

    /** Seeds a future, already-synced (so past the reconcile grace window) calendar item linked to sync-config-1. */
    async function seedLinkedFutureItem(userId: string, id: string, eventId: string, overrides: Partial<ItemInterface> = {}) {
        const futureTs = dayjs().add(2, 'day').toISOString();
        const oldTs = dayjs().subtract(1, 'day').toISOString();
        await itemsDAO.insertOne({
            _id: id,
            user: userId,
            status: 'calendar',
            title: id,
            timeStart: futureTs,
            timeEnd: futureTs,
            calendarEventId: eventId,
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            createdTs: oldTs,
            updatedTs: oldTs,
            ...overrides,
        });
        return futureTs;
    }

    it('trashes an orphaned future item when its event is absent from the full-sync snapshot', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await seedLinkedFutureItem(userId, 'item-vanished', 'evt-gone');

        // Full sync returns NO events — the linked event has been deleted on GCal.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-vanished' });
        expect(item?.status).toBe('trash');
        // Stamped like a reactive cancellation so the trash view shows the "Cancelled in Calendar" badge.
        expect(item?.cancelledByGCal).toBe(true);

        // An operation must be recorded so other devices converge on the trash on their next pull.
        const ops = await operationsDAO.findArray({ user: userId, entityType: 'item', entityId: 'item-vanished' });
        const [trashOp] = ops;
        if (!trashOp) throw new Error('expected a recorded trash operation for the reconciled item');
        expect(trashOp.snapshot?.status).toBe('trash');
    });

    it('trashes a vanished ALL-DAY item (timeStart is YYYY-MM-DD, not an ISO datetime)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // All-day item dated two days out — `timeStart`/`timeEnd` are bare `YYYY-MM-DD`. This is the
        // case a lexicographic Mongo `$gte` against the ISO-datetime `timeMin` would mishandle; the
        // dayjs window filter must still place it inside the window and trash it.
        const futureDate = dayjs().add(2, 'day').format('YYYY-MM-DD');
        await seedLinkedFutureItem(userId, 'item-allday', 'evt-allday-gone', { timeStart: futureDate, timeEnd: futureDate, allDay: true });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-allday' });
        expect(item?.status).toBe('trash');
    });

    it('shields a just-created item with no lastPushedToGCalTs via the updatedTs grace fallback', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Item created in-app seconds ago that has NOT yet been pushed to GCal (no lastPushedToGCalTs).
        // The grace guard falls back to `updatedTs`, so the freshly-created item is shielded from a
        // false trash while its push to GCal is still in flight.
        await seedLinkedFutureItem(userId, 'item-fresh-noPush', 'evt-fresh-noPush', { updatedTs: dayjs().toISOString() });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-fresh-noPush' });
        expect(item?.status).toBe('calendar');
    });

    it('does NOT trash a non-routine item whose calendarEventId is in instance form (can never match the master-only snapshot)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // A non-routine item carrying an instance-form id (`<master>_<YYYYMMDDTHHMMSSZ>`).
        // `listEventsFull` is master-only and `normalizeMasterEventId` doesn't strip the instance
        // suffix, so this id could never appear in the snapshot — trashing on its absence would be a
        // false positive. The bare-master-form guard must exclude it.
        await seedLinkedFutureItem(userId, 'item-instanceform', 'mastermtg_20260620T120000Z');

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-instanceform' });
        expect(item?.status).toBe('calendar');
    });

    it('does NOT trash a non-routine item whose calendarEventId is in ALL-DAY instance form (_YYYYMMDD, no T)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // All-day instance suffix has no `T<time>Z` component — exercises the regex's optional group.
        await seedLinkedFutureItem(userId, 'item-instanceform-allday', 'mastermtg_20260620');

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-instanceform-allday' });
        expect(item?.status).toBe('calendar');
    });

    it('does NOT trash an item whose event is still present in the snapshot', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const futureTs = await seedLinkedFutureItem(userId, 'item-present', 'evt-live');

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'evt-live',
                    title: 'item-present',
                    timeStart: futureTs,
                    timeEnd: futureTs,
                    updated: dayjs().subtract(1, 'day').toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-1',
        });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-present' });
        expect(item?.status).toBe('calendar');
    });

    it('does NOT run the sweep on an incremental sync (a delta is not an authoritative snapshot)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const { config } = await insertIntegrationWithConfig(userId);
        // A stored syncToken forces the incremental path.
        await calendarSyncConfigsDAO.upsertSyncToken(config._id, 'tok-existing', dayjs().subtract(1, 'hour').toISOString());
        await seedLinkedFutureItem(userId, 'item-incr', 'evt-incr');

        // Incremental returns an empty delta — nothing changed. The orphan must survive: an empty
        // delta means "no changes seen", not "the event is gone".
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue({ events: [], nextSyncToken: 'tok-incr-next' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-incr' });
        expect(item?.status).toBe('calendar');
    });

    it('runs the sweep on the 410-fallback full sync after an expired syncToken', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const { config } = await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.upsertSyncToken(config._id, 'tok-stale', dayjs().subtract(1, 'hour').toISOString());
        await seedLinkedFutureItem(userId, 'item-410', 'evt-410-gone');

        // Incremental throws 410 → falls back to a full sync, which returns no events. The orphan
        // strands forever today (the new token is minted post-deletion); the sweep is the only heal.
        const { SyncTokenInvalidError } = await import('../calendarProviders/CalendarProvider.js');
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockRejectedValue(new SyncTokenInvalidError());
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-410-next' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-410' });
        expect(item?.status).toBe('trash');
        expect(item?.cancelledByGCal).toBe(true);
    });

    it('leaves items outside the snapshot window untouched (past timeStart, routine-managed, other config)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const oldTs = dayjs().subtract(1, 'day').toISOString();
        const pastTs = dayjs().subtract(2, 'day').toISOString();

        // Past item: before timeMin, so outside the [timeMin, ∞) snapshot — the full sync never
        // claimed authority over it.
        await itemsDAO.insertOne({
            _id: 'item-past',
            user: userId,
            status: 'calendar',
            title: 'past',
            timeStart: pastTs,
            timeEnd: pastTs,
            calendarEventId: 'evt-past',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            createdTs: pastTs,
            updatedTs: oldTs,
        });
        // Routine-managed future item: lifecycle owned by the routine path, never the standalone sweep.
        await itemsDAO.insertOne({
            _id: 'item-routine',
            user: userId,
            status: 'calendar',
            title: 'routine occ',
            timeStart: dayjs().add(2, 'day').toISOString(),
            timeEnd: dayjs().add(2, 'day').toISOString(),
            calendarEventId: 'evt-routine',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            routineId: 'routine-1',
            createdTs: oldTs,
            updatedTs: oldTs,
        });
        // Future item on a DIFFERENT sync config: not part of this config's snapshot.
        await itemsDAO.insertOne({
            _id: 'item-othercfg',
            user: userId,
            status: 'calendar',
            title: 'other cfg',
            timeStart: dayjs().add(2, 'day').toISOString(),
            timeEnd: dayjs().add(2, 'day').toISOString(),
            calendarEventId: 'evt-othercfg',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-OTHER',
            createdTs: oldTs,
            updatedTs: oldTs,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        expect((await itemsDAO.findOne({ _id: 'item-past' }))?.status).toBe('calendar');
        expect((await itemsDAO.findOne({ _id: 'item-routine' }))?.status).toBe('calendar');
        expect((await itemsDAO.findOne({ _id: 'item-othercfg' }))?.status).toBe('calendar');
    });

    it('shields a just-pushed item from a false trash while its create propagates to GCal', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Item pushed to GCal seconds ago — its create may not be in GCal's list index yet. Trashing
        // it now would be a false positive; the grace window protects it.
        await seedLinkedFutureItem(userId, 'item-fresh', 'evt-fresh', { lastPushedToGCalTs: dayjs().toISOString() });

        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-1' });

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const item = await itemsDAO.findOne({ _id: 'item-fresh' });
        expect(item?.status).toBe('calendar');
    });
});
