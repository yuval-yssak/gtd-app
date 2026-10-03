/**
 * Repair for items orphaned by the pre-carry-forward link loss (see calendarLinkCarryForward.test.ts):
 * a `done` item whose Google event exists but whose row lost `calendarEventId`. The event id is
 * deterministic (`buildDeterministicGCalId(itemId, integrationId)`), so the relink sweep that runs
 * on every full sync (and from the "Repair sync" button) probes Google for it, relinks a hit and
 * pushes the ✓ marker the original completion never delivered.
 */
import dayjs from 'dayjs';
import { describe, expect, it, vi } from 'vitest';
import { buildDeterministicGCalId, GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import { DONE_COLOR_ID } from '../lib/doneMarker.js';
import { relinkCalendarMarkersForUser } from '../routes/calendar.js';
import type { ItemInterface } from '../types/entities.js';
import { app, getUserId, insertIntegrationWithConfig, loginAsAlice, makeItem, makeSyncConfig, useCalendarTestLifecycle } from './calendarTestKit.js';
import { authenticatedRequest } from './helpers.js';

useCalendarTestLifecycle();

const FUTURE_START = dayjs().add(3, 'day').startOf('hour').toISOString();
const FUTURE_END = dayjs().add(3, 'day').startOf('hour').add(1, 'hour').toISOString();

/** The incident row: completed in-app (timeStart kept), no link at all, recent. */
function orphanedDone(userId: string, overrides: Partial<ItemInterface> = {}): ItemInterface {
    const completedAt = dayjs().subtract(2, 'day').toISOString();
    return makeItem(userId, {
        _id: 'item-orphan-done',
        status: 'done',
        title: 'Demo: sync to Google Calendar',
        timeStart: FUTURE_START,
        timeEnd: FUTURE_END,
        createdTs: completedAt,
        updatedTs: completedAt,
        ...overrides,
    });
}

async function seedFixture() {
    const sessionCookie = await loginAsAlice();
    const userId = await getUserId(sessionCookie);
    // Connected a month ago: the repair only looks at rows updated after the integration existed.
    const { integration, config } = await insertIntegrationWithConfig(userId, {
        accountEmail: 'alice@example.com',
        createdTs: dayjs().subtract(30, 'day').toISOString(),
    });
    // No syncToken → the manual sync is a FULL sync → the relink sweep (and this repair) run after import.
    vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-orphan' });
    vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
    return { sessionCookie, userId, integration, config };
}

/** Google still has the app-created event under its deterministic id. */
function mockGoogleHasEvent(eventId: string, title: string) {
    return vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockImplementation(async (_calendarId, id) =>
        id === eventId
            ? {
                  id,
                  title,
                  timeStart: FUTURE_START,
                  timeEnd: FUTURE_END,
                  updated: dayjs().subtract(2, 'day').toISOString(),
                  status: 'confirmed',
                  htmlLink: 'https://calendar.google.com/event?eid=orphan',
              }
            : null,
    );
}

async function runManualSync(sessionCookie: string, integrationId: string) {
    const res = await authenticatedRequest(app, { method: 'POST', path: `/calendar/integrations/${integrationId}/sync`, sessionCookie });
    expect(res.status).toBe(200);
}

describe('relink sweep — orphaned done items (link lost before the Google create round-tripped)', () => {
    it('relinks the done item to its deterministic event, records an op and pushes the ✓ marker', async () => {
        const { sessionCookie, userId, integration, config } = await seedFixture();
        const seeded = orphanedDone(userId);
        await itemsDAO.insertOne(seeded);
        const eventId = buildDeterministicGCalId('item-orphan-done', integration._id);
        const getEventSpy = mockGoogleHasEvent(eventId, seeded.title);
        const updateEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue();

        await runManualSync(sessionCookie, integration._id);

        const row = await itemsDAO.findByOwnerAndId('item-orphan-done', userId);
        expect(row?.calendarEventId).toBe(eventId);
        expect(row?.calendarIntegrationId).toBe(integration._id);
        expect(row?.calendarSyncConfigId).toBe(config._id);
        expect(row?.htmlLink).toBe('https://calendar.google.com/event?eid=orphan');
        expect(row?.status).toBe('done');
        expect(row?.lastPushedToGCalTs).toBeTruthy();
        expect(getEventSpy).toHaveBeenCalledWith('primary', eventId);
        // The ✓ marker the original completion never delivered.
        expect(updateEventSpy).toHaveBeenCalledTimes(1);
        const [, patchedId, patch] = updateEventSpy.mock.calls[0] as [string, string, { title: string; colorId: string }];
        expect(patchedId).toBe(eventId);
        expect(patch.title).toBe(`✓ ${seeded.title}`);
        expect(patch.colorId).toBe(DONE_COLOR_ID);
        // Other devices learn the link through the op log.
        const ops = await operationsDAO.findArray({ user: userId, entityType: 'item', entityId: 'item-orphan-done' });
        expect(ops.map((op) => (op.snapshot as ItemInterface).calendarEventId)).toContain(eventId);
    });

    it('is idempotent — a second sweep finds nothing to repair', async () => {
        const { userId, integration } = await seedFixture();
        await itemsDAO.insertOne(orphanedDone(userId));
        const eventId = buildDeterministicGCalId('item-orphan-done', integration._id);
        const getEventSpy = mockGoogleHasEvent(eventId, 'Demo: sync to Google Calendar');
        const updateEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue();

        expect((await relinkCalendarMarkersForUser(userId)).relinkedDoneItems).toBe(1);
        const probesAfterFirst = getEventSpy.mock.calls.length;
        expect((await relinkCalendarMarkersForUser(userId)).relinkedDoneItems).toBe(0);

        expect(getEventSpy.mock.calls.length).toBe(probesAfterFirst);
        expect(updateEventSpy).toHaveBeenCalledTimes(1);
    });

    it('leaves the row alone when Google has no event under that id (never pushed, or deleted by hand)', async () => {
        const { sessionCookie, userId, integration } = await seedFixture();
        await itemsDAO.insertOne(orphanedDone(userId));
        const before = await itemsDAO.findByOwnerAndId('item-orphan-done', userId);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(null);
        const updateEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue();

        await runManualSync(sessionCookie, integration._id);

        expect(await itemsDAO.findByOwnerAndId('item-orphan-done', userId)).toEqual(before);
        expect(updateEventSpy).not.toHaveBeenCalled();
    });

    it('leaves the row alone when the event is cancelled on Google', async () => {
        const { sessionCookie, userId, integration } = await seedFixture();
        const seeded = orphanedDone(userId);
        await itemsDAO.insertOne(seeded);
        const eventId = buildDeterministicGCalId('item-orphan-done', integration._id);
        vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue({
            id: eventId,
            title: seeded.title,
            timeStart: FUTURE_START,
            timeEnd: FUTURE_END,
            updated: dayjs().toISOString(),
            status: 'cancelled',
        });

        await runManualSync(sessionCookie, integration._id);

        expect((await itemsDAO.findByOwnerAndId('item-orphan-done', userId))?.calendarEventId).toBeUndefined();
    });

    it.each([
        ['a calendar row (the outbound backfill owns those)', { status: 'calendar' as const }],
        ['a trash row (deleting on inference is outward-facing)', { status: 'trash' as const }],
        ['a routine-generated row (its presence is the series master)', { routineId: 'routine-x' }],
        ['a disconnect-kept row (the marker sweep owns those)', { lastKnownCalendarEventId: 'evt-kept' }],
        ['a row stamped with another integration', { calendarIntegrationId: 'integ-other' }],
        ['a done row older than the repair window', { updatedTs: dayjs().subtract(61, 'day').toISOString() }],
    ])('does not probe Google for %s', async (_label, overrides) => {
        const { sessionCookie, userId, integration } = await seedFixture();
        await itemsDAO.insertOne(orphanedDone(userId, overrides));
        const getEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(null);

        await runManualSync(sessionCookie, integration._id);

        // The marker sweep may probe a `lastKnown*` row by ITS id; the repair's deterministic id must never be asked for.
        const deterministicId = buildDeterministicGCalId('item-orphan-done', integration._id);
        expect(getEventSpy.mock.calls.map(([, id]) => id)).not.toContain(deterministicId);
    });

    it('does not probe Google for a done row that never had a time (never a calendar item)', async () => {
        const { sessionCookie, userId, integration } = await seedFixture();
        // Build without the keys (not `undefined` values — the driver would store those as null).
        const { timeStart: _s, timeEnd: _e, ...untimed } = orphanedDone(userId);
        await itemsDAO.insertOne(untimed);
        const getEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(null);

        await runManualSync(sessionCookie, integration._id);

        expect(getEventSpy).not.toHaveBeenCalled();
    });

    it('runs BEFORE the full-sync import, so the orphan’s event updates the done row instead of importing a second open item', async () => {
        const { sessionCookie, userId, integration } = await seedFixture();
        await itemsDAO.insertOne(orphanedDone(userId));
        const eventId = buildDeterministicGCalId('item-orphan-done', integration._id);
        // The authoritative full-sync snapshot includes the orphan's own event (it is in the future).
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: eventId,
                    title: 'Demo: sync to Google Calendar',
                    timeStart: FUTURE_START,
                    timeEnd: FUTURE_END,
                    updated: dayjs().subtract(2, 'day').toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-orphan',
        });
        mockGoogleHasEvent(eventId, 'Demo: sync to Google Calendar');
        vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue();

        await runManualSync(sessionCookie, integration._id);

        const linked = await itemsDAO.findArray({ user: userId, calendarEventId: eventId });
        expect(linked).toHaveLength(1);
        const [row] = linked;
        if (!row) throw new Error('expected the relinked done row');
        expect(row._id).toBe('item-orphan-done');
        expect(row.status).toBe('done');
        expect(await itemsDAO.findArray({ user: userId, status: 'calendar' })).toHaveLength(0);
    });

    it('does not link a second row to an event another item already owns', async () => {
        const { sessionCookie, userId, integration } = await seedFixture();
        await itemsDAO.insertOne(orphanedDone(userId));
        const eventId = buildDeterministicGCalId('item-orphan-done', integration._id);
        await itemsDAO.insertOne(
            makeItem(userId, {
                _id: 'item-already-owns',
                calendarEventId: eventId,
                calendarIntegrationId: integration._id,
                calendarSyncConfigId: 'sync-config-1',
            }),
        );
        mockGoogleHasEvent(eventId, 'Demo: sync to Google Calendar');
        const updateEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue();

        await runManualSync(sessionCookie, integration._id);

        expect((await itemsDAO.findByOwnerAndId('item-orphan-done', userId))?.calendarEventId).toBeUndefined();
        expect(updateEventSpy).not.toHaveBeenCalled();
    });

    it('a failed ✓ push after the relink is surfaced on the relink op (SyncIssues Retry re-fires it)', async () => {
        const { sessionCookie, userId, integration } = await seedFixture();
        await itemsDAO.insertOne(orphanedDone(userId));
        const eventId = buildDeterministicGCalId('item-orphan-done', integration._id);
        mockGoogleHasEvent(eventId, 'Demo: sync to Google Calendar');
        vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockRejectedValue(Object.assign(new Error('Rate Limit Exceeded'), { code: 403 }));

        await runManualSync(sessionCookie, integration._id);

        expect((await itemsDAO.findByOwnerAndId('item-orphan-done', userId))?.calendarEventId).toBe(eventId);
        const failed = await operationsDAO.findArray({ user: userId, entityType: 'item', entityId: 'item-orphan-done', syncFailed: true });
        expect(failed).toHaveLength(1);
        const [relinkOp] = failed;
        if (!relinkOp) throw new Error('expected the relink op to be marked');
        expect((relinkOp.snapshot as ItemInterface).calendarEventId).toBe(eventId);
        expect(relinkOp.failureReason).toBe('transient_exhausted');
    });

    it('stops probing after an invalid_grant instead of burning the loop on dead credentials', async () => {
        const { sessionCookie, userId, integration } = await seedFixture();
        await itemsDAO.insertOne(orphanedDone(userId, { _id: 'item-orphan-a' }));
        await itemsDAO.insertOne(orphanedDone(userId, { _id: 'item-orphan-b' }));
        const getEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockRejectedValue(new Error('invalid_grant'));

        await runManualSync(sessionCookie, integration._id);

        expect(getEventSpy).toHaveBeenCalledTimes(1);
    });

    it('probes nothing on a fresh connect — rows updated before the integration existed cannot be its orphans', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // Integration created just now; the candidate was completed two days ago.
        const { integration } = await insertIntegrationWithConfig(userId, { accountEmail: 'alice@example.com' });
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-fresh' });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        await itemsDAO.insertOne(orphanedDone(userId));
        const getEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(null);

        await runManualSync(sessionCookie, integration._id);

        expect(getEventSpy).not.toHaveBeenCalled();
    });

    it('probes each calendar once per full sync (the per-calendar pass scopes the repair to its own calendar)', async () => {
        const { sessionCookie, userId, integration } = await seedFixture();
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(userId, integration._id, { _id: 'sync-config-2', calendarId: 'secondary', isDefault: false }));
        await itemsDAO.insertOne(orphanedDone(userId));
        const eventId = buildDeterministicGCalId('item-orphan-done', integration._id);
        const getEventSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'getEvent').mockResolvedValue(null);

        await runManualSync(sessionCookie, integration._id);

        const probes = getEventSpy.mock.calls.filter(([, id]) => id === eventId).map(([calendarId]) => calendarId);
        expect(probes.sort()).toEqual(['primary', 'secondary']);
    });

    it('runs from the on-demand "Repair sync" sweep as well and reports the count', async () => {
        const { userId, integration } = await seedFixture();
        await itemsDAO.insertOne(orphanedDone(userId));
        const eventId = buildDeterministicGCalId('item-orphan-done', integration._id);
        mockGoogleHasEvent(eventId, 'Demo: sync to Google Calendar');
        vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue();

        const result = await relinkCalendarMarkersForUser(userId);

        expect(result.relinkedDoneItems).toBe(1);
        expect((await itemsDAO.findByOwnerAndId('item-orphan-done', userId))?.calendarEventId).toBe(eventId);
    });
});
