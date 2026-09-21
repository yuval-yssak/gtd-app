/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { maybePushToGCal } from '../lib/calendarPushback.js';
import { auth } from '../loaders/mainLoader.js';
import { calendarRoutes } from '../routes/calendar.js';
import { maintenanceRoutes } from '../routes/maintenance.js';
import type { ItemInterface, RoutineInterface } from '../types/entities.js';
import {
    app,
    getUserId,
    insertIntegrationWithConfig,
    loginAsAlice,
    makeIntegration,
    makeItem,
    makeOp,
    makeRoutine,
    makeSyncConfig,
    mockBuildProvider,
    useCalendarTestLifecycle,
} from './calendarTestKit.js';
import { authenticatedRequest, oauthLogin } from './helpers.js';

useCalendarTestLifecycle();

// ─── Active relink sweep (stranded lastKnown* markers) ───────────────────────

describe('relink sweep — active resolution of stranded lastKnown* markers', () => {
    const FUTURE_START = dayjs().add(5, 'day').startOf('hour').toISOString();
    const FUTURE_END = dayjs().add(5, 'day').startOf('hour').add(30, 'minute').toISOString();
    const LOCAL_EDIT_START = dayjs().add(9, 'day').startOf('hour').toISOString();
    const LOCAL_EDIT_END = dayjs().add(9, 'day').startOf('hour').add(30, 'minute').toISOString();

    /** Seeds alice + a live integration (accountEmail stamped) and mocks an empty full sync so the sweep is the only actor. */
    async function seedSweepFixture() {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const { integration, config } = await insertIntegrationWithConfig(userId, { accountEmail: 'alice@example.com' });
        // No syncToken on the config → the manual sync runs a FULL sync → the sweep fires after import.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-sweep' });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        return { sessionCookie, userId, integration, config };
    }

    function makeMarkerItem(userId: string, overrides: Partial<ItemInterface> = {}): ItemInterface {
        const contact = dayjs().subtract(7, 'day').toISOString();
        return {
            _id: 'item-stranded',
            user: userId,
            status: 'calendar',
            title: 'Return the booster',
            timeStart: FUTURE_START,
            timeEnd: FUTURE_END,
            createdTs: contact,
            updatedTs: contact,
            lastPushedToGCalTs: contact,
            lastSyncedFromGCalTs: contact,
            lastKnownCalendarEventId: 'gtd-stranded-event',
            lastKnownCalendarIntegrationId: 'int-1',
            lastKnownCalendarSyncConfigId: 'sync-config-dead',
            lastKnownCalendarAccountEmail: 'alice@example.com',
            ...overrides,
        };
    }

    /** GCal event frozen at the last agreed state: updated == the item's last contact anchor. */
    function makeFrozenEvent(item: ItemInterface) {
        return {
            id: 'gtd-stranded-event',
            title: item.title,
            timeStart: item.timeStart ?? FUTURE_START,
            timeEnd: item.timeEnd ?? FUTURE_END,
            updated: item.lastSyncedFromGCalTs ?? dayjs().subtract(7, 'day').toISOString(),
            status: 'confirmed' as const,
        };
    }

    async function runManualSync(sessionCookie: string, integrationId: string) {
        const res = await authenticatedRequest(app, { method: 'POST', path: `/calendar/integrations/${integrationId}/sync`, sessionCookie });
        expect(res.status).toBe(200);
    }

    it('relinks a locally-edited item against an unmodified event and pushes the local state to GCal (the stranded-reschedule bug)', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        // The b50e8cd3 shape: item rescheduled in-app AFTER the disconnect; the GCal event is frozen
        // at the old time and was never modified since → no sync window would ever surface it.
        const seeded = makeMarkerItem(userId, { timeStart: LOCAL_EDIT_START, timeEnd: LOCAL_EDIT_END, updatedTs: dayjs().toISOString() });
        await itemsDAO.insertOne(seeded);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(makeFrozenEvent({ ...seeded, timeStart: FUTURE_START, timeEnd: FUTURE_END }));
        const updateEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue();

        await runManualSync(sessionCookie, integration._id);

        const item = await itemsDAO.findByOwnerAndId('item-stranded', userId);
        expect(item?.calendarEventId).toBe('gtd-stranded-event');
        expect(item?.calendarIntegrationId).toBe(integration._id);
        expect(item?.calendarSyncConfigId).toBe('sync-config-1');
        expect(item?.lastKnownCalendarEventId).toBeUndefined();
        expect(item?.lastKnownCalendarAccountEmail).toBeUndefined();
        // Local state won: the rescheduled time was pushed out to GCal.
        expect(updateEventSpy).toHaveBeenCalledTimes(1);
        const [, eventId, updates] = updateEventSpy.mock.calls[0]!;
        expect(eventId).toBe('gtd-stranded-event');
        expect(updates.timeStart).toBe(LOCAL_EDIT_START);
        // The push stamped the item so the webhook echo of our own update is suppressed.
        const stamped = await itemsDAO.findByOwnerAndId('item-stranded', userId);
        expect(stamped?.lastPushedToGCalTs).toBeDefined();
        expect(dayjs(stamped?.lastPushedToGCalTs).isAfter(dayjs().subtract(1, 'minute'))).toBe(true);
    });

    it('relinks an untouched item against a GCal-edited event and applies the event state locally', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        const seeded = makeMarkerItem(userId);
        await itemsDAO.insertOne(seeded);
        // GCal moved the event while disconnected; the app item was never edited.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue({
            ...makeFrozenEvent(seeded),
            timeStart: LOCAL_EDIT_START,
            timeEnd: LOCAL_EDIT_END,
            updated: dayjs().subtract(1, 'day').toISOString(),
        });
        const updateEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue();

        await runManualSync(sessionCookie, integration._id);

        const item = await itemsDAO.findByOwnerAndId('item-stranded', userId);
        expect(item?.calendarEventId).toBe('gtd-stranded-event');
        expect(item?.timeStart).toBe(LOCAL_EDIT_START);
        expect(item?.lastKnownCalendarEventId).toBeUndefined();
        expect(updateEventSpy).not.toHaveBeenCalled();
    });

    it('relinks a content-equal marker quietly and a second sweep run records nothing (idempotent)', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        const seeded = makeMarkerItem(userId);
        await itemsDAO.insertOne(seeded);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(makeFrozenEvent(seeded));
        const updateEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue();

        await runManualSync(sessionCookie, integration._id);
        const item = await itemsDAO.findByOwnerAndId('item-stranded', userId);
        expect(item?.calendarEventId).toBe('gtd-stranded-event');
        expect(updateEventSpy).not.toHaveBeenCalled();
        const opsAfterFirst = await operationsDAO.findArray({ user: userId, entityType: 'item', entityId: 'item-stranded' });
        expect(opsAfterFirst).toHaveLength(1); // the restore op only

        // Clear the syncToken so the second manual sync is a FULL sync again — the sweep must re-run.
        // The full snapshot must now INCLUDE the event (the item is linked, and a snapshot missing it
        // would legitimately trigger the vanished-event reconcile) — the first sync omitted it to
        // model the stranded case, where the event sits outside the snapshot window.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [makeFrozenEvent(seeded)],
            nextSyncToken: 'tok-sweep-2',
        });
        await calendarSyncConfigsDAO.upsertSyncToken('sync-config-1', '', dayjs().toISOString());
        await runManualSync(sessionCookie, integration._id);
        const opsAfterSecond = await operationsDAO.findArray({ user: userId, entityType: 'item', entityId: 'item-stranded' });
        expect(opsAfterSecond).toHaveLength(1); // no marker left — the sweep had nothing to do
    });

    it('recreates the GCal event for a locally-edited item whose event is gone (hybrid: local wins)', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        const seeded = makeMarkerItem(userId, { timeStart: LOCAL_EDIT_START, timeEnd: LOCAL_EDIT_END, updatedTs: dayjs().toISOString() });
        await itemsDAO.insertOne(seeded);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(null);
        const createEventSpy = vi
            .spyOn(GoogleCalendarProvider.prototype, 'createEvent')
            .mockResolvedValue({ eventId: 'recreated-event-id', htmlLink: 'https://cal.example/recreated' });

        await runManualSync(sessionCookie, integration._id);

        expect(createEventSpy).toHaveBeenCalledTimes(1);
        const item = await itemsDAO.findByOwnerAndId('item-stranded', userId);
        expect(item?.status).toBe('calendar');
        expect(item?.lastKnownCalendarEventId).toBeUndefined();
        expect(item?.calendarEventId).toBeDefined();
    });

    it('trashes an untouched item whose event was deleted on GCal (hybrid: deletion wins), stamping cancelledByGCal', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        const seeded = makeMarkerItem(userId);
        await itemsDAO.insertOne(seeded);
        // A cancellation tombstone newer than the item's last local touch.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue({
            ...makeFrozenEvent(seeded),
            status: 'cancelled',
            updated: dayjs().subtract(1, 'day').toISOString(),
        });
        const createEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'never' });

        await runManualSync(sessionCookie, integration._id);

        const item = await itemsDAO.findByOwnerAndId('item-stranded', userId);
        expect(item?.status).toBe('trash');
        expect(item?.cancelledByGCal).toBe(true);
        expect(item?.lastKnownCalendarEventId).toBeUndefined();
        expect(createEventSpy).not.toHaveBeenCalled();
    });

    it('clears markers on a done item whose event is gone without trashing or recreating', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        const seeded = makeMarkerItem(userId, { status: 'done' });
        await itemsDAO.insertOne(seeded);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(null);
        const createEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'never' });

        await runManualSync(sessionCookie, integration._id);

        const item = await itemsDAO.findByOwnerAndId('item-stranded', userId);
        expect(item?.status).toBe('done');
        expect(item?.lastKnownCalendarEventId).toBeUndefined();
        expect(createEventSpy).not.toHaveBeenCalled();
    });

    it('never touches a marker stamped with a different account email — not even a lookup', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        const seeded = makeMarkerItem(userId, {
            lastKnownCalendarIntegrationId: 'int-WORK-dead',
            lastKnownCalendarAccountEmail: 'work@example.com',
        });
        await itemsDAO.insertOne(seeded);
        const getEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(null);

        await runManualSync(sessionCookie, integration._id);

        const item = await itemsDAO.findByOwnerAndId('item-stranded', userId);
        expect(item?.lastKnownCalendarEventId).toBe('gtd-stranded-event');
        expect(item?.lastKnownCalendarAccountEmail).toBe('work@example.com');
        expect(getEventSpy).not.toHaveBeenCalled();
    });

    it('relinks a legacy email-less marker when its event resolves, but skips it (no trash/recreate) when it does not', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        // Legacy marker: no origin email, dead integration id → provenance unproven.
        const resolvable = makeMarkerItem(userId, {
            _id: 'item-legacy-found',
            lastKnownCalendarEventId: 'legacy-found-event',
            lastKnownCalendarIntegrationId: 'int-legacy-dead',
        });
        const { lastKnownCalendarAccountEmail: _dropA, ...legacyFound } = resolvable;
        const unresolvable = makeMarkerItem(userId, {
            _id: 'item-legacy-missing',
            title: 'Other legacy',
            lastKnownCalendarEventId: 'legacy-missing-event',
            lastKnownCalendarIntegrationId: 'int-legacy-dead',
        });
        const { lastKnownCalendarAccountEmail: _dropB, ...legacyMissing } = unresolvable;
        await itemsDAO.insertOne(legacyFound);
        await itemsDAO.insertOne(legacyMissing);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockImplementation(async (_calendarId: string, eventId: string) =>
            eventId === 'legacy-found-event' ? { ...makeFrozenEvent(legacyFound), id: 'legacy-found-event' } : null,
        );

        await runManualSync(sessionCookie, integration._id);

        // Found on this account's calendar → safe to relink.
        const found = await itemsDAO.findByOwnerAndId('item-legacy-found', userId);
        expect(found?.calendarEventId).toBe('legacy-found-event');
        // Not found → could belong to an account we can't see: left untouched, NOT trashed.
        const missing = await itemsDAO.findByOwnerAndId('item-legacy-missing', userId);
        expect(missing?.status).toBe('calendar');
        expect(missing?.lastKnownCalendarEventId).toBe('legacy-missing-event');
    });

    it('restores a stranded routine through the full import path when its master resolves live', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-stranded',
                active: false,
                updatedTs: dayjs().subtract(7, 'day').toISOString(),
                lastKnownCalendarEventId: 'gcal-stranded-master',
                lastKnownCalendarIntegrationId: 'int-1',
                lastKnownCalendarSyncConfigId: 'sync-config-dead',
                lastKnownCalendarAccountEmail: 'alice@example.com',
            }),
        );
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue({
            id: 'gcal-stranded-master',
            title: 'Standup',
            timeStart: FUTURE_START,
            timeEnd: FUTURE_END,
            updated: dayjs().subtract(6, 'day').toISOString(),
            status: 'confirmed',
            recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
        });

        await runManualSync(sessionCookie, integration._id);

        const routine = await routinesDAO.findByOwnerAndId('routine-stranded', userId);
        expect(routine?.calendarEventId).toBe('gcal-stranded-master');
        expect(routine?.calendarIntegrationId).toBe(integration._id);
        expect(routine?.lastKnownCalendarEventId).toBeUndefined();
        // Open inbound rrule + inactive local → the disconnect-inflicted pause is lifted.
        expect(routine?.active).toBe(true);
    });

    it('recreates a fresh series for an active routine whose master is hard-gone, and deactivates an inactive one on a newer tombstone', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-recreate',
                active: true,
                lastKnownCalendarEventId: 'gcal-gone-master',
                lastKnownCalendarIntegrationId: 'int-1',
                lastKnownCalendarSyncConfigId: 'sync-config-dead',
                lastKnownCalendarAccountEmail: 'alice@example.com',
            }),
        );
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(null);
        const createSeriesSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('fresh-master-id');

        await runManualSync(sessionCookie, integration._id);

        expect(createSeriesSpy).toHaveBeenCalledTimes(1);
        const routine = await routinesDAO.findByOwnerAndId('routine-recreate', userId);
        expect(routine?.lastKnownCalendarEventId).toBeUndefined();
        expect(routine?.active).toBe(true);
        expect(routine?.calendarEventId).toBeDefined();
    });

    it('deactivation path: an active routine whose master was cancelled AFTER its last local touch is deactivated, future items trashed', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        const staleTouch = dayjs().subtract(7, 'day').toISOString();
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-deactivate',
                active: true,
                updatedTs: staleTouch,
                lastKnownCalendarEventId: 'gcal-cancelled-master',
                lastKnownCalendarIntegrationId: 'int-1',
                lastKnownCalendarSyncConfigId: 'sync-config-dead',
                lastKnownCalendarAccountEmail: 'alice@example.com',
            }),
        );
        await itemsDAO.insertOne({
            _id: 'item-future-occurrence',
            user: userId,
            status: 'calendar',
            title: 'Standup',
            routineId: 'routine-deactivate',
            timeStart: FUTURE_START,
            timeEnd: FUTURE_END,
            createdTs: staleTouch,
            updatedTs: staleTouch,
        });
        // Cancellation tombstone NEWER than the routine's last local touch → deletion wins.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue({
            id: 'gcal-cancelled-master',
            title: '',
            timeStart: '',
            timeEnd: '',
            updated: dayjs().subtract(1, 'day').toISOString(),
            status: 'cancelled',
        });
        const createSeriesSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('never');

        await runManualSync(sessionCookie, integration._id);

        expect(createSeriesSpy).not.toHaveBeenCalled();
        const routine = await routinesDAO.findByOwnerAndId('routine-deactivate', userId);
        expect(routine?.active).toBe(false);
        expect(routine?.lastKnownCalendarEventId).toBeUndefined();
        const occurrence = await itemsDAO.findByOwnerAndId('item-future-occurrence', userId);
        expect(occurrence?.status).toBe('trash');
    });

    it('POST /maintenance/relink-calendar-markers heals a stranded item on demand and reports counts', async () => {
        const maintenanceApp = new Hono()
            .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
            .route('/calendar', calendarRoutes)
            .route('/maintenance', maintenanceRoutes);
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        const seeded = makeMarkerItem(userId);
        await itemsDAO.insertOne(seeded);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(makeFrozenEvent(seeded));

        const res = await authenticatedRequest(maintenanceApp, { method: 'POST', path: '/maintenance/relink-calendar-markers', sessionCookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { relinkedItems: number };
        expect(body.relinkedItems).toBe(1);

        const item = await itemsDAO.findByOwnerAndId('item-stranded', userId);
        expect(item?.calendarEventId).toBe('gtd-stranded-event');
        expect(item?.calendarIntegrationId).toBe(integration._id);
        expect(item?.lastKnownCalendarEventId).toBeUndefined();
    });

    it("POST /maintenance/relink-calendar-markers is tenant-isolated — another user's markers stay untouched", async () => {
        const maintenanceApp = new Hono()
            .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
            .route('/calendar', calendarRoutes)
            .route('/maintenance', maintenanceRoutes);
        const { sessionCookie } = await seedSweepFixture();
        // A second user (bob) with the same-shaped stranded marker AND a live integration of his own.
        const { sessionCookie: bobCookieRaw } = await oauthLogin(app, 'github');
        if (!bobCookieRaw) throw new Error('expected bob session cookie');
        const bobId = await getUserId(bobCookieRaw);
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration(bobId, { _id: 'int-bob', accountEmail: 'alice@example.com' }));
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(bobId, 'int-bob', { _id: 'sync-config-bob' }));
        const bobMarkerItem = makeMarkerItem(bobId, { _id: 'item-bob-stranded', lastKnownCalendarIntegrationId: 'int-bob' });
        await itemsDAO.insertOne(bobMarkerItem);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(makeFrozenEvent(bobMarkerItem));

        // Alice's sweep: she has no markers, and bob's must not be visible to her session.
        const res = await authenticatedRequest(maintenanceApp, { method: 'POST', path: '/maintenance/relink-calendar-markers', sessionCookie });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { relinkedItems: number; trashedItems: number; recreatedEvents: number };
        expect(body.relinkedItems).toBe(0);
        expect(body.trashedItems).toBe(0);
        expect(body.recreatedEvents).toBe(0);

        const bobItem = await itemsDAO.findByOwnerAndId('item-bob-stranded', bobId);
        expect(bobItem?.lastKnownCalendarEventId).toBe('gtd-stranded-event');
        expect(bobItem?.calendarEventId).toBeUndefined();
    });

    it('relinks a done marker item against its live event quietly — no outbound push, done stays done', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        // Done items keep their timeStart/timeEnd; on GCal the event carries the "✓ " done marker
        // in its title, which the content comparison must strip before deciding anything changed.
        const seeded = makeMarkerItem(userId, { status: 'done' });
        await itemsDAO.insertOne(seeded);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue({
            ...makeFrozenEvent(seeded),
            title: `✓ ${seeded.title}`,
        });
        const updateEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue();

        await runManualSync(sessionCookie, integration._id);

        const item = await itemsDAO.findByOwnerAndId('item-stranded', userId);
        expect(item?.status).toBe('done');
        expect(item?.calendarEventId).toBe('gtd-stranded-event');
        expect(item?.lastKnownCalendarEventId).toBeUndefined();
        expect(updateEventSpy).not.toHaveBeenCalled();
    });

    // ── Split-successor markers (calendarRebasedEventId) ─────────────────────
    // After a "this and all following" split, the live master lives under the raw `_R<anchor>` id
    // while the bare id is the capped stump. A successor marker routine must therefore resolve
    // against its OWN rebased master — fetching only the bare id can never relink it.

    const REBASED_ID = 'gcal-split-base_R20260601T060000Z';
    const BARE_ID = 'gcal-split-base';

    function makeSuccessorMarkerRoutine(userId: string, overrides: Partial<RoutineInterface> = {}) {
        return makeRoutine(userId, {
            _id: 'routine-split-successor',
            active: false,
            updatedTs: dayjs().subtract(7, 'day').toISOString(),
            calendarRebasedEventId: REBASED_ID,
            lastKnownCalendarEventId: BARE_ID,
            lastKnownCalendarIntegrationId: 'int-1',
            lastKnownCalendarSyncConfigId: 'sync-config-dead',
            lastKnownCalendarAccountEmail: 'alice@example.com',
            ...overrides,
        });
    }

    function makeLiveRebasedMaster() {
        return {
            id: REBASED_ID,
            title: 'Standup',
            timeStart: FUTURE_START,
            timeEnd: FUTURE_END,
            updated: dayjs().subtract(6, 'day').toISOString(),
            status: 'confirmed' as const,
            recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
        };
    }

    it('relinks a stranded split-successor routine through its rebased _R master — the bare stump id is never fetched', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        await routinesDAO.insertOne(makeSuccessorMarkerRoutine(userId));
        const getEventSpy = vi
            .spyOn(GoogleCalendarProvider.prototype, 'getEvent')
            .mockImplementation(async (_calendarId: string, eventId: string) => (eventId === REBASED_ID ? makeLiveRebasedMaster() : null));

        await runManualSync(sessionCookie, integration._id);

        const routine = await routinesDAO.findByOwnerAndId('routine-split-successor', userId);
        // Linked on the BARE id (GCal instance ids use it), with the rebased idempotency key preserved.
        expect(routine?.calendarEventId).toBe(BARE_ID);
        expect(routine?.calendarIntegrationId).toBe(integration._id);
        expect(routine?.calendarRebasedEventId).toBe(REBASED_ID);
        expect(routine?.lastKnownCalendarEventId).toBeUndefined();
        expect(routine?.lastKnownCalendarAccountEmail).toBeUndefined();
        // Open inbound rrule + inactive local → the disconnect-inflicted pause is lifted.
        expect(routine?.active).toBe(true);
        expect(getEventSpy.mock.calls.every(([, eventId]) => eventId === REBASED_ID)).toBe(true);
    });

    it('a gone bare master never gone-resolves a successor whose own master is alive: base sheds markers, successor relinks', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        const staleTouch = dayjs().subtract(7, 'day').toISOString();
        // The capped base of the split, also stranded — inactive, as the disconnect cascade left it.
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-split-base',
                active: false,
                updatedTs: staleTouch,
                rrule: `FREQ=WEEKLY;BYDAY=MO;UNTIL=${dayjs().subtract(30, 'day').format('YYYYMMDD')}T000000Z`,
                lastKnownCalendarEventId: BARE_ID,
                lastKnownCalendarIntegrationId: 'int-1',
                lastKnownCalendarSyncConfigId: 'sync-config-dead',
                lastKnownCalendarAccountEmail: 'alice@example.com',
            }),
        );
        await routinesDAO.insertOne(makeSuccessorMarkerRoutine(userId));
        // The user deleted the capped stump on GCal (tombstone newer than any local touch) while the
        // successor series lives on — the old grouped-by-bare-id sweep would have gone-resolved BOTH.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockImplementation(async (_calendarId: string, eventId: string) => {
            if (eventId === REBASED_ID) {
                return makeLiveRebasedMaster();
            }
            if (eventId === BARE_ID) {
                return { id: BARE_ID, title: '', timeStart: '', timeEnd: '', updated: dayjs().subtract(1, 'day').toISOString(), status: 'cancelled' as const };
            }
            return null;
        });
        const createSeriesSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('never');

        await runManualSync(sessionCookie, integration._id);

        // Base: inactive + newer tombstone → deletion wins quietly (markers cleared, stays inactive).
        const base = await routinesDAO.findByOwnerAndId('routine-split-base', userId);
        expect(base?.lastKnownCalendarEventId).toBeUndefined();
        expect(base?.active).toBe(false);
        expect(base?.calendarEventId).toBeUndefined();
        // Successor: relinked and reactivated against its own live master, untouched by the tombstone.
        const successor = await routinesDAO.findByOwnerAndId('routine-split-successor', userId);
        expect(successor?.calendarEventId).toBe(BARE_ID);
        expect(successor?.active).toBe(true);
        expect(successor?.lastKnownCalendarEventId).toBeUndefined();
        expect(createSeriesSpy).not.toHaveBeenCalled();
    });

    it('never touches a split-successor marker stamped with a different account email — not even a rebased-id lookup', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        await routinesDAO.insertOne(
            makeSuccessorMarkerRoutine(userId, {
                lastKnownCalendarIntegrationId: 'int-WORK-dead',
                lastKnownCalendarAccountEmail: 'work@example.com',
            }),
        );
        const getEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(null);

        await runManualSync(sessionCookie, integration._id);

        const routine = await routinesDAO.findByOwnerAndId('routine-split-successor', userId);
        expect(routine?.lastKnownCalendarEventId).toBe(BARE_ID);
        expect(routine?.lastKnownCalendarAccountEmail).toBe('work@example.com');
        expect(routine?.active).toBe(false);
        expect(getEventSpy).not.toHaveBeenCalled();
    });

    it('recreates a fresh series for an ACTIVE split successor whose rebased master is hard-gone', async () => {
        const { sessionCookie, userId, integration } = await seedSweepFixture();
        await routinesDAO.insertOne(makeSuccessorMarkerRoutine(userId, { active: true, updatedTs: dayjs().toISOString() }));
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(null);
        const createSeriesSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('fresh-successor-series');

        await runManualSync(sessionCookie, integration._id);

        expect(createSeriesSpy).toHaveBeenCalledTimes(1);
        const routine = await routinesDAO.findByOwnerAndId('routine-split-successor', userId);
        expect(routine?.lastKnownCalendarEventId).toBeUndefined();
        expect(routine?.active).toBe(true);
        expect(routine?.calendarEventId).toBeDefined();
    });
});

// ─── Master-linked standalone item convergence ─────────────────────────────
//
// A GCal event can be synced as a standalone one-off item BEFORE its series is recognized as a
// routine (`recurrence` not visible at first sight). The leftover item then links straight to the
// series MASTER — marking it done used to PATCH the ✓ marker + sage colorId onto the master,
// flagging every future occurrence done for all attendees, and the ✓ then round-tripped into the
// routine's and open items' stored titles. Two layers of defense are covered here:
//  1. import-side absorb: importing (or re-reporting) a recurring master converges any standalone
//     item still linked to it — open duplicates are trashed, done ones are unlinked;
//  2. pushback-side guard: a master-linked item push reroutes to a single-instance override and
//     never PATCHes or deletes the master itself.

describe('recurring-master import absorbs master-linked standalone items', () => {
    const tomorrowAt9 = () => dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T09:00:00`, 'Asia/Jerusalem').format();
    const tomorrowAt10 = () => dayjs.tz(`${dayjs().add(1, 'day').format('YYYY-MM-DD')}T10:00:00`, 'Asia/Jerusalem').format();

    function mockMasterInFullSync() {
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-master-absorb',
                    title: 'Daily standup',
                    timeStart: tomorrowAt9(),
                    timeEnd: tomorrowAt10(),
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                    recurrence: ['RRULE:FREQ=DAILY'],
                },
            ],
            nextSyncToken: 'tok-absorb',
        });
    }

    function makeMasterLinkedStandaloneItem(userId: string, overrides: Partial<ItemInterface> = {}) {
        return makeItem(userId, {
            _id: 'item-master-dup',
            title: 'Daily standup',
            calendarEventId: 'gcal-master-absorb',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            timeStart: tomorrowAt9(),
            timeEnd: tomorrowAt10(),
            ...overrides,
        });
    }

    it('trashes an open standalone duplicate when the series is imported as a routine', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await itemsDAO.insertOne(makeMasterLinkedStandaloneItem(userId));
        mockMasterInFullSync();

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const routine = await routinesDAO.findOne({ user: userId, calendarEventId: 'gcal-master-absorb' });
        expect(routine).not.toBeNull();
        // The standalone duplicate no longer competes with the routine's generated items.
        const absorbed = await itemsDAO.findByOwnerAndId('item-master-dup', userId);
        expect(absorbed?.status).toBe('trash');
        // The convergence rode the operation log so other devices apply it too.
        const ops = await operationsDAO.findArray({ user: userId, entityType: 'item', entityId: 'item-master-dup' });
        expect(ops).toHaveLength(1);
        expect(ops[0]!.snapshot).toMatchObject({ status: 'trash' });
    });

    it('unlinks (not trashes) a done standalone duplicate so the completion record survives', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await itemsDAO.insertOne(makeMasterLinkedStandaloneItem(userId, { status: 'done' }));
        mockMasterInFullSync();

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const absorbed = await itemsDAO.findByOwnerAndId('item-master-dup', userId);
        expect(absorbed?.status).toBe('done');
        expect(absorbed?.calendarEventId).toBeUndefined();
        const ops = await operationsDAO.findArray({ user: userId, entityType: 'item', entityId: 'item-master-dup' });
        expect(ops).toHaveLength(1);
        expect(ops[0]!.snapshot).toMatchObject({ status: 'done' });
        expect(ops[0]!.snapshot).not.toHaveProperty('calendarEventId');
    });

    it('self-heals pre-existing damage: a master re-report absorbs the duplicate via updateRoutineFromGCal', async () => {
        // The routine already exists (imported before the absorb fix) and the standalone duplicate
        // lingers — the next re-report of the master must converge it even though the routine's
        // schedule may be structurally unchanged.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await routinesDAO.insertOne(
            makeRoutine(userId, {
                _id: 'routine-absorb-existing',
                title: 'Daily standup',
                rrule: 'FREQ=DAILY',
                calendarEventId: 'gcal-master-absorb',
                calendarIntegrationId: 'int-1',
                calendarSyncConfigId: 'sync-config-1',
            }),
        );
        await itemsDAO.insertOne(makeMasterLinkedStandaloneItem(userId));
        mockMasterInFullSync();

        const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
        expect(res.status).toBe(200);

        const absorbed = await itemsDAO.findByOwnerAndId('item-master-dup', userId);
        expect(absorbed?.status).toBe('trash');
        // No second routine was minted for the same series.
        const routines = await routinesDAO.findArray({ user: userId, calendarEventId: 'gcal-master-absorb' });
        expect(routines).toHaveLength(1);
    });
});

describe('pushback guard — item linked to a recurring MASTER event', () => {
    async function insertMasterRoutine(userId: string, overrides: Partial<RoutineInterface> = {}) {
        const routine = makeRoutine(userId, {
            _id: 'routine-master-guard',
            title: 'Daily standup',
            calendarEventId: 'recurring-master-guard',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            ...overrides,
        });
        await routinesDAO.insertOne(routine);
        return routine;
    }

    function makeMasterLinkedItem(userId: string, overrides: Partial<ItemInterface> = {}) {
        return makeItem(userId, {
            _id: 'item-master-linked',
            title: 'Daily standup',
            calendarEventId: 'recurring-master-guard',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            ...overrides,
        });
    }

    it('marking a master-linked item done patches a single instance override — never the master', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertMasterRoutine(userId);
        const item = makeMasterLinkedItem(userId, { status: 'done' });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);
        const instanceSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        // The whole-event PATCH (which would have applied the ✓ + sage color to EVERY occurrence
        // of the series) must never fire against a master id.
        expect(updateSpy).not.toHaveBeenCalled();
        expect(instanceSpy).toHaveBeenCalledOnce();
        const [eventId, originalDate, updates] = instanceSpy.mock.calls[0]!;
        expect(eventId).toBe('recurring-master-guard');
        expect(originalDate).toBe(dayjs(item.timeStart).format('YYYY-MM-DD'));
        expect(updates).toMatchObject({ title: '✓ Daily standup', colorId: '2' });
        // The reroute stamps the push anchor like any other instance override.
        const updated = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(updated?.lastPushedToGCalTs).toBeTruthy();
    });

    it('a generic edit of a master-linked item reroutes to an instance override too', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertMasterRoutine(userId);
        const item = makeMasterLinkedItem(userId, { status: 'calendar' });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);
        const instanceSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(updateSpy).not.toHaveBeenCalled();
        expect(instanceSpy).toHaveBeenCalledOnce();
        const updates = instanceSpy.mock.calls[0]![2];
        expect(updates).toMatchObject({ title: 'Daily standup', colorId: null });
    });

    it('trashing a master-linked item skips the delete — never removes the series', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertMasterRoutine(userId);
        const item = makeMasterLinkedItem(userId, { status: 'trash' });
        await itemsDAO.insertOne(item);

        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue(undefined);
        const cancelSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(deleteSpy).not.toHaveBeenCalled();
        expect(cancelSpy).not.toHaveBeenCalled();
    });

    it('hard-deleting a master-linked item skips the GCal delete — never removes the series', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertMasterRoutine(userId);
        const item = makeMasterLinkedItem(userId, { status: 'calendar' });

        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue(undefined);

        // Delete ops arrive with the pre-delete row hydrated as the snapshot.
        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, opType: 'delete', snapshot: item }), mockBuildProvider());

        expect(deleteSpy).not.toHaveBeenCalled();
    });

    it('reroutes onto the ACTIVE split successor, not the capped base, when a split shares the bare id', async () => {
        // After "this and all following", the capped inactive base and the live successor
        // legitimately coexist on ONE bare calendarEventId (the unique index is active-partial).
        // The reroute must resolve the successor: the base's capped rrule and retired sync config
        // would make the instance-window lookup come up empty and silently drop the push. The base
        // carries the NEWER updatedTs to prove selection is by `active`, not recency.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertMasterRoutine(userId, {
            _id: 'routine-split-capped-base',
            active: false,
            rrule: 'FREQ=DAILY;UNTIL=20260101T000000Z',
            updatedTs: dayjs().toISOString(),
            routineExceptions: [{ date: '2026-01-01', type: 'modified', itemId: 'item-master-linked' }],
        });
        await insertMasterRoutine(userId, {
            _id: 'routine-split-live-successor',
            active: true,
            updatedTs: dayjs().subtract(1, 'day').toISOString(),
            routineExceptions: [{ date: '2026-09-01', type: 'modified', itemId: 'item-master-linked' }],
        });
        const item = makeMasterLinkedItem(userId, { status: 'done' });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);
        const instanceSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(updateSpy).not.toHaveBeenCalled();
        expect(instanceSpy).toHaveBeenCalledOnce();
        // The originalDate comes from the resolved routine's `modified` exception for this item —
        // 2026-09-01 proves the successor supplied the context, not the newer-updatedTs base.
        const [, originalDate] = instanceSpy.mock.calls[0]!;
        expect(originalDate).toBe('2026-09-01');
    });

    it("does not forward the duplicate item's import-frozen attendees — the occurrence keeps inheriting from the master", async () => {
        // The standalone duplicate's attendees snapshot dates from import and is never refreshed
        // (master ids route to the routine import path). An RSVP since then would read as
        // divergence and permanently fork this occurrence off the master's list (RFC 5545
        // per-instance attendee override) — for what the user experienced as ticking a checkbox.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertMasterRoutine(userId, {
            attendees: [
                { email: 'a@example.com', responseStatus: 'accepted' },
                { email: 'b@example.com', responseStatus: 'needsAction' },
            ],
        });
        const item = makeMasterLinkedItem(userId, {
            status: 'done',
            // Frozen pre-RSVP snapshot — differs from the routine's current list.
            attendees: [
                { email: 'a@example.com', responseStatus: 'needsAction' },
                { email: 'b@example.com', responseStatus: 'needsAction' },
            ],
        });
        await itemsDAO.insertOne(item);

        const instanceSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(instanceSpy).toHaveBeenCalledOnce();
        expect(instanceSpy.mock.calls[0]![2]).not.toHaveProperty('attendees');
    });
});
