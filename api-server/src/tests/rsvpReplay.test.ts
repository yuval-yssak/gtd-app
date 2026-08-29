/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts result before using ! */
import dayjs from 'dayjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import { applyAndPublishOperations } from '../lib/applyOperation.js';
import * as calendarPushback from '../lib/calendarPushback.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { CalendarIntegrationInterface, CalendarSyncConfigInterface, ItemInterface } from '../types/entities.js';

// Lifecycle ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
    await loadDataAccess('gtd_test_rsvp_replay');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([
        db.collection('items').deleteMany({}),
        db.collection('routines').deleteMany({}),
        db.collection('operations').deleteMany({}),
        db.collection('calendarIntegrations').deleteMany({}),
        db.collection('calendarSyncConfigs').deleteMany({}),
    ]);
    vi.restoreAllMocks();
    // Calendar TZ lookup is unrelated to the RSVP path but cached in resolvePushContext, mock to
    // avoid the live network call when gcalMeta tests trigger maybePushToGCal.
    vi.spyOn(GoogleCalendarProvider.prototype, 'getCalendarTimeZone').mockResolvedValue('Asia/Jerusalem');
});

afterEach(() => {
    // Each test that toggles fake timers restores them itself, but enforce real-timers cleanup
    // as a belt-and-braces — leaking fake timers across files corrupts later suites.
    vi.useRealTimers();
});

// Helpers ────────────────────────────────────────────────────────────────────

const USER_ID = 'user-rsvp-replay';
const DEVICE_ID = 'device-rsvp-test';

function makeIntegration(overrides: Partial<CalendarIntegrationInterface> = {}): CalendarIntegrationInterface {
    const now = dayjs().toISOString();
    return {
        _id: 'int-rsvp',
        user: USER_ID,
        provider: 'google',
        accessToken: 'at',
        refreshToken: 'rt',
        tokenExpiry: now,
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
}

function makeSyncConfig(overrides: Partial<CalendarSyncConfigInterface> = {}): CalendarSyncConfigInterface {
    const now = dayjs().toISOString();
    return {
        _id: 'sync-rsvp',
        integrationId: 'int-rsvp',
        user: USER_ID,
        calendarId: 'primary',
        isDefault: true,
        enabled: true,
        timeZone: 'Asia/Jerusalem',
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
}

function makeCalendarItem(overrides: Partial<ItemInterface> = {}): ItemInterface {
    const now = dayjs().toISOString();
    return {
        _id: 'item-rsvp-1',
        user: USER_ID,
        status: 'calendar',
        title: 'Team standup',
        timeStart: dayjs().add(1, 'day').toISOString(),
        timeEnd: dayjs().add(1, 'day').add(30, 'minute').toISOString(),
        calendarEventId: 'gcal-rsvp-event',
        calendarIntegrationId: 'int-rsvp',
        calendarSyncConfigId: 'sync-rsvp',
        attendees: [
            { email: 'me@example.com', responseStatus: 'needsAction', self: true },
            { email: 'organizer@example.com', responseStatus: 'accepted', organizer: true },
        ],
        responseStatus: 'needsAction',
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
}

async function seedAll(integrationOverrides?: Partial<CalendarIntegrationInterface>, itemOverrides?: Partial<ItemInterface>) {
    const integration = makeIntegration(integrationOverrides);
    await calendarIntegrationsDAO.insertEncrypted(integration);
    const config = makeSyncConfig();
    await calendarSyncConfigsDAO.insertOne(config);
    const item = makeCalendarItem(itemOverrides);
    await itemsDAO.insertOne(item);
    return { integration, config, item };
}

/**
 * Pushes a single `rsvp` op through the offline-first /sync/push replay pipeline. Lets each test
 * stay tightly focused on the assertions instead of wiring `applyAndPublishOperations` plumbing.
 */
async function pushRsvpOp(itemId: string, responseStatus: 'accepted' | 'declined' | 'tentative'): Promise<string> {
    const { ops } = await applyAndPublishOperations(
        USER_ID,
        [
            {
                entityType: 'item',
                entityId: itemId,
                opType: 'rsvp',
                snapshot: null,
                rsvp: {
                    itemId,
                    calendarEventId: 'gcal-rsvp-event',
                    calendarIntegrationId: 'int-rsvp',
                    responseStatus,
                },
            },
        ],
        { deviceId: DEVICE_ID, strict: false },
    );
    const [op] = ops;
    if (!op) {
        throw new Error('expected one persisted op');
    }
    return op._id;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('rsvp opType replay via /sync/push', () => {
    it('updates the item and calls patchEventAttendees with sendUpdates:all on success', async () => {
        await seedAll();
        vi.spyOn(GoogleCalendarProvider.prototype, 'getMyEmail').mockResolvedValue('me@example.com');
        const patchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'patchEventAttendees').mockResolvedValue(undefined);

        const opId = await pushRsvpOp('item-rsvp-1', 'accepted');

        // Provider was called with sendUpdates:'all' — RSVP always notifies the organizer.
        expect(patchSpy).toHaveBeenCalledOnce();
        const [args] = patchSpy.mock.calls;
        if (!args) throw new Error('expected one patch call');
        const [calendarId, eventId, attendees, options] = args;
        expect(calendarId).toBe('primary');
        expect(eventId).toBe('gcal-rsvp-event');
        expect(options).toEqual({ sendUpdates: 'all' });
        expect(attendees).toEqual([
            { email: 'me@example.com', responseStatus: 'accepted', self: true },
            { email: 'organizer@example.com', responseStatus: 'accepted', organizer: true },
        ]);

        // Local item state mirrors the new attendee list + responseStatus + push-stamp.
        const stored = await itemsDAO.findByOwnerAndId('item-rsvp-1', USER_ID);
        expect(stored?.responseStatus).toBe('accepted');
        expect(stored?.attendees?.find((a) => a.self)?.responseStatus).toBe('accepted');
        expect(stored?.lastPushedToGCalTs).toBeDefined();

        // The op row carries no failure markers.
        const persisted = await operationsDAO.findOne({ _id: opId });
        expect(persisted?.syncFailed).toBeUndefined();
    });

    it('marks op syncFailed with terminal when the item is missing', async () => {
        // No item seeded — only integration + config so config lookup doesn't short-circuit first.
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration());
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig());

        const opId = await pushRsvpOp('item-missing', 'accepted');

        const persisted = await operationsDAO.findOne({ _id: opId });
        expect(persisted?.syncFailed).toBe(true);
        expect(persisted?.failureReason).toBe('terminal');
        expect(persisted?.failureDetail).toContain('item missing');
        expect(persisted?.failedTs).toBeDefined();
    });

    it('marks op syncFailed with terminal AND reverts responseStatus when GCal returns 404', async () => {
        // Seed the item with an already-set responseStatus to simulate the optimistic-update case
        // (the client updated locally + queued an update op, then queued the rsvp op).
        await seedAll(undefined, { responseStatus: 'accepted' });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getMyEmail').mockResolvedValue('me@example.com');
        // 404 is a terminal GCal error — event was deleted between optimistic update and replay.
        const gcalErr = Object.assign(new Error('Not Found'), { code: 404 });
        vi.spyOn(GoogleCalendarProvider.prototype, 'patchEventAttendees').mockRejectedValue(gcalErr);

        const opId = await pushRsvpOp('item-rsvp-1', 'declined');

        const persisted = await operationsDAO.findOne({ _id: opId });
        expect(persisted?.syncFailed).toBe(true);
        expect(persisted?.failureReason).toBe('terminal');
        expect(persisted?.failureDetail).toContain('Not Found');

        // responseStatus reverted to the prior server value (accepted) — NOT the requested 'declined'.
        const stored = await itemsDAO.findByOwnerAndId('item-rsvp-1', USER_ID);
        expect(stored?.responseStatus).toBe('accepted');
    });

    it('marks op syncFailed with scope_missing when GCal throws invalid_grant', async () => {
        await seedAll();
        vi.spyOn(GoogleCalendarProvider.prototype, 'getMyEmail').mockResolvedValue('me@example.com');
        vi.spyOn(GoogleCalendarProvider.prototype, 'patchEventAttendees').mockRejectedValue(new Error('invalid_grant'));

        const opId = await pushRsvpOp('item-rsvp-1', 'accepted');

        const persisted = await operationsDAO.findOne({ _id: opId });
        expect(persisted?.syncFailed).toBe(true);
        expect(persisted?.failureReason).toBe('scope_missing');
    });

    it('retries on transient 500 and succeeds on the second attempt', async () => {
        await seedAll();
        vi.spyOn(GoogleCalendarProvider.prototype, 'getMyEmail').mockResolvedValue('me@example.com');
        const transientErr = Object.assign(new Error('boom'), { code: 500 });
        // First call throws transient, subsequent calls resolve — proves retry kicks in.
        const patchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'patchEventAttendees').mockRejectedValueOnce(transientErr).mockResolvedValueOnce(undefined);

        // The 1s real-time backoff between attempt 1 and attempt 2 is intentional: faking timers
        // here would also fake MongoDB's poll loop and hang every subsequent DAO call. ~1s sleep
        // is the worst case for this single test and it stays well under vitest's default 5s
        // testTimeout. If the budget changes (e.g. retryWithBackoff is rewritten to ramp faster
        // on the first attempt), revisit this.
        const opId = await pushRsvpOp('item-rsvp-1', 'accepted');

        expect(patchSpy).toHaveBeenCalledTimes(2);
        const persisted = await operationsDAO.findOne({ _id: opId });
        expect(persisted?.syncFailed).toBeUndefined();
        const stored = await itemsDAO.findByOwnerAndId('item-rsvp-1', USER_ID);
        expect(stored?.responseStatus).toBe('accepted');
    });
});

describe('update opType with gcalMeta sidecar', () => {
    it('persists gcalMeta on the op row so the pushback layer can read it back', async () => {
        await seedAll();

        const now = dayjs().add(1, 'minute').toISOString();
        const snapshot: ItemInterface = makeCalendarItem({ title: 'Renamed standup', updatedTs: now });

        await applyAndPublishOperations(
            USER_ID,
            [
                {
                    entityType: 'item',
                    entityId: 'item-rsvp-1',
                    opType: 'update',
                    snapshot,
                    gcalMeta: { sendUpdates: 'all' },
                },
            ],
            { deviceId: DEVICE_ID, strict: false },
        );

        // Persistence: the sidecar must land verbatim on the operation row. The pushback layer
        // already threads `op.gcalMeta?.sendUpdates` into the provider call (verified by the
        // calendar.test.ts suite); proving the field reached Mongo is enough here.
        const ops = await operationsDAO.findArray({ user: USER_ID, opType: 'update' });
        expect(ops).toHaveLength(1);
        const [op] = ops;
        if (!op) throw new Error('expected one update op');
        expect(op.gcalMeta).toEqual({ sendUpdates: 'all' });
    });

    it('drives the sendUpdates value through maybePushToGCal into provider.updateEvent', async () => {
        // Direct synchronous assertion against the pushback function — no race with notifyChanges'
        // fire-and-forget path.
        await seedAll();
        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);

        const snapshot: ItemInterface = makeCalendarItem({ title: 'Renamed standup' });
        await calendarPushback.maybePushToGCal(
            {
                _id: 'op-meta',
                user: USER_ID,
                deviceId: DEVICE_ID,
                ts: dayjs().toISOString(),
                entityType: 'item',
                entityId: 'item-rsvp-1',
                opType: 'update',
                snapshot,
                gcalMeta: { sendUpdates: 'all' },
            },
            (integration) => new GoogleCalendarProvider(integration),
        );

        expect(updateSpy).toHaveBeenCalledOnce();
        const [args] = updateSpy.mock.calls;
        if (!args) throw new Error('expected an updateEvent call');
        // sendUpdates is the trailing options argument on updateEvent's signature.
        expect(args[args.length - 1]).toEqual({ sendUpdates: 'all' });
    });
});

describe('rsvp op validation', () => {
    it('strict-mode rejects an rsvp op carrying an invalid responseStatus before any GCal call', async () => {
        await seedAll();
        const patchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'patchEventAttendees').mockResolvedValue(undefined);

        // 'BOGUS' is not in the {accepted, declined, tentative} enum — the Zod RsvpOpPayloadSchema must reject it.
        await expect(
            applyAndPublishOperations(
                USER_ID,
                [
                    {
                        entityType: 'item',
                        entityId: 'item-rsvp-1',
                        opType: 'rsvp',
                        snapshot: null,
                        // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing the type guard to simulate a malformed client payload
                        rsvp: { itemId: 'item-rsvp-1', calendarEventId: 'gcal-rsvp-event', calendarIntegrationId: 'int-rsvp', responseStatus: 'BOGUS' as any },
                    },
                ],
                { deviceId: DEVICE_ID, strict: true },
            ),
        ).rejects.toThrow();

        // No GCal push fired — the validator short-circuited before the replay path ran.
        expect(patchSpy).not.toHaveBeenCalled();
    });
});

describe('integration: maybePushToGCal ignores rsvp ops with null snapshot', () => {
    // Sanity test that the legacy pushback path stays a no-op for rsvp — the new replay path owns
    // the GCal side-effect, and double-pushing would emit two organizer emails.
    it('does not invoke the provider when called with an rsvp op', async () => {
        await seedAll();
        const patchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'patchEventAttendees').mockResolvedValue(undefined);

        await calendarPushback.maybePushToGCal(
            {
                _id: 'op-x',
                user: USER_ID,
                deviceId: DEVICE_ID,
                ts: dayjs().toISOString(),
                entityType: 'item',
                entityId: 'item-rsvp-1',
                opType: 'rsvp',
                snapshot: null,
                rsvp: { itemId: 'item-rsvp-1', calendarEventId: 'gcal-rsvp-event', calendarIntegrationId: 'int-rsvp', responseStatus: 'accepted' },
            },
            // buildProvider is unused in the rsvp branch (snapshot is null), so a permissive factory is fine.
            (integration) => new GoogleCalendarProvider(integration),
        );

        expect(patchSpy).not.toHaveBeenCalled();
    });
});
