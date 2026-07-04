/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts queried docs are present */
import dayjs from 'dayjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncTokenInvalidError } from '../calendarProviders/CalendarProvider.js';
import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import sentEmailsDAO from '../dataAccess/sentEmailsDAO.js';
import * as sseConnections from '../lib/sseConnections.js';
import { renewAllExpiring } from '../lib/webhookRenewal.js';
import * as webPush from '../lib/webPush.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { CalendarIntegrationInterface, CalendarSyncConfigInterface } from '../types/entities.js';

const ORIG_WEBHOOK_URL = process.env.CALENDAR_WEBHOOK_URL;
const ORIG_GRACE_MS = process.env.CALENDAR_AUTH_GRACE_MS;

beforeAll(async () => {
    await loadDataAccess('gtd_test_webhook_renewal');
    // setupWatch is a no-op without this env var — the renewal would never call provider.watchEvents.
    process.env.CALENDAR_WEBHOOK_URL = 'https://test.example/webhook';
});

afterAll(async () => {
    if (ORIG_WEBHOOK_URL === undefined) {
        delete process.env.CALENDAR_WEBHOOK_URL;
    } else {
        process.env.CALENDAR_WEBHOOK_URL = ORIG_WEBHOOK_URL;
    }
    await closeDataAccess();
});

afterEach(() => {
    if (ORIG_GRACE_MS === undefined) {
        delete process.env.CALENDAR_AUTH_GRACE_MS;
    } else {
        process.env.CALENDAR_AUTH_GRACE_MS = ORIG_GRACE_MS;
    }
});

beforeEach(async () => {
    await Promise.all([
        db.collection('user').deleteMany({}),
        db.collection('calendarIntegrations').deleteMany({}),
        db.collection('calendarSyncConfigs').deleteMany({}),
        db.collection('sentEmails').deleteMany({}),
        db.collection('items').deleteMany({}),
        db.collection('routines').deleteMany({}),
        db.collection('operations').deleteMany({}),
    ]);
    vi.restoreAllMocks();
});

function makeIntegration(overrides: Partial<CalendarIntegrationInterface> = {}): CalendarIntegrationInterface {
    const now = dayjs().toISOString();
    return {
        _id: 'int-1',
        user: 'user-1',
        provider: 'google',
        accessToken: 'at',
        refreshToken: 'rt',
        tokenExpiry: now,
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
}

function makeConfig(overrides: Partial<CalendarSyncConfigInterface> = {}): CalendarSyncConfigInterface {
    const now = dayjs().toISOString();
    return {
        _id: 'cfg-1',
        integrationId: 'int-1',
        user: 'user-1',
        calendarId: 'primary',
        isDefault: true,
        enabled: true,
        // No webhookExpiry → findNeedingWebhook picks it up.
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
}

async function seedUserEmail(userId: string, email: string) {
    await db.collection('user').insertOne({ _id: userId, email, name: 'Test User' } as never);
}

/** Polls `predicate` until truthy or 1 s elapses — used to await fire-and-forget escalation side-effects. */
async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
        if (await predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('waitFor timeout — predicate never became truthy');
}

function makeInvalidGrantError(): Error {
    return Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } });
}

describe('webhook renewal — invalid_grant escalation', () => {
    it('marks an active integration suspended and writes a warning email row on first invalid_grant', async () => {
        await seedUserEmail('user-1', 'alice@example.com');
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration({ status: 'active' }));
        await calendarSyncConfigsDAO.insertOne(makeConfig());
        vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockRejectedValue(makeInvalidGrantError());

        await renewAllExpiring();
        // The escalation side-effect runs fire-and-forget inside withAuthFailureHandling. The
        // unawaited handleAuthFailure performs several Mongo round-trips serially:
        // findById → markSuspended → findById → sendEmail. Wait for the LAST step (the email
        // row) so the assertions below race-free; previously this polled only on `status` and
        // flaked under load when the email insert was still pending.
        await waitFor(async () => (await sentEmailsDAO.findArray({ userId: 'user-1' })).length >= 1);

        const integration = await calendarIntegrationsDAO.findById('int-1');
        expect(integration?.status).toBe('suspended');
        expect(integration?.suspendedAt).toBeTruthy();

        const emails = await sentEmailsDAO.findArray({ userId: 'user-1' });
        expect(emails).toHaveLength(1);
        expect(emails[0]!.kind).toBe('calendar_auth_warning');
        expect(emails[0]!.to).toBe('alice@example.com');
    });

    it('a second renewal pass does NOT advance a suspended integration to revoked — renewal skips suspended', async () => {
        // Renewal explicitly skips non-active integrations (see webhookRenewal.ts). Re-escalation
        // to `revoked` happens via the sync endpoint, which still attempts the operation. Document
        // the skip behavior here; the time-based revoke transition itself is unit-tested in
        // calendarAuthEscalation.test.ts.
        await seedUserEmail('user-1', 'alice@example.com');
        process.env.CALENDAR_AUTH_GRACE_MS = '1';
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration({ status: 'active' }));
        await calendarSyncConfigsDAO.insertOne(makeConfig());
        const watchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockRejectedValue(makeInvalidGrantError());

        await renewAllExpiring();
        await waitFor(async () => (await calendarIntegrationsDAO.findById('int-1'))?.status === 'suspended');
        watchSpy.mockClear();

        // Wait long enough that the grace window would elapse, then run renewal again.
        await new Promise((resolve) => setTimeout(resolve, 20));
        await renewAllExpiring();

        // Renewal saw status=suspended and skipped — no provider call, status unchanged.
        expect(watchSpy).not.toHaveBeenCalled();
        const integration = await calendarIntegrationsDAO.findById('int-1');
        expect(integration?.status).toBe('suspended');
    });

    it('isolates a non-auth failure from invalid_grant — only the latter integration is suspended', async () => {
        await seedUserEmail('user-1', 'alice@example.com');
        await seedUserEmail('user-2', 'bob@example.com');
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration({ _id: 'int-A', user: 'user-1', status: 'active' }));
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration({ _id: 'int-B', user: 'user-2', status: 'active' }));
        await calendarSyncConfigsDAO.insertOne(makeConfig({ _id: 'cfg-A', integrationId: 'int-A', user: 'user-1' }));
        await calendarSyncConfigsDAO.insertOne(makeConfig({ _id: 'cfg-B', integrationId: 'int-B', user: 'user-2', calendarId: 'work' }));

        vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockImplementation(async (calendarId: string) => {
            if (calendarId === 'primary') {
                throw new Error('500 Internal Server Error'); // non-auth failure on int-A
            }
            throw makeInvalidGrantError(); // auth failure on int-B
        });

        await renewAllExpiring();
        // Same race as the first test: the markSuspended → sendEmail chain is fire-and-forget.
        // Wait for the email insert (last step) so the assertions below are race-free.
        await waitFor(async () => (await sentEmailsDAO.findArray({ userId: 'user-2' })).length >= 1);

        const intA = await calendarIntegrationsDAO.findById('int-A');
        const intB = await calendarIntegrationsDAO.findById('int-B');
        expect(intA?.status ?? 'active').toBe('active'); // not suspended — non-auth error
        expect(intB?.status).toBe('suspended');

        const emails = await sentEmailsDAO.findArray({});
        expect(emails).toHaveLength(1);
        expect(emails[0]!.userId).toBe('user-2');
    });

    it('skips suspended integrations in the renewal loop and does not call the provider', async () => {
        await seedUserEmail('user-1', 'alice@example.com');
        const suspendedAt = dayjs().toISOString();
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration({ status: 'suspended', suspendedAt }));
        await calendarSyncConfigsDAO.insertOne(makeConfig());
        const watchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents');

        await renewAllExpiring();

        expect(watchSpy).not.toHaveBeenCalled();
        const integration = await calendarIntegrationsDAO.findById('int-1');
        // Status preserved — escalation does NOT run on a skipped integration.
        expect(integration?.status).toBe('suspended');
    });
});

describe('webhook renewal — catch-up sync after a lapsed channel', () => {
    /** Stubs the provider calls the renewal + catch-up path makes, returning the incremental spy for assertions. */
    function stubProviderForCatchUp(incremental: { events: object[]; nextSyncToken: string }) {
        vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({
            resourceId: 'res-fresh',
            expiration: dayjs().add(7, 'day').toISOString(),
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'getCalendarTimeZone').mockResolvedValue('UTC');
        const fullSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-full' });
        const incrementalSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsIncremental').mockResolvedValue(incremental as never);
        return { incrementalSpy, fullSpy };
    }

    it('drains the notification gap: a cancellation missed while the channel was dead trashes the local item', async () => {
        await seedUserEmail('user-1', 'alice@example.com');
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration({ status: 'active' }));
        // Channel lapsed 3 days ago — the exact incident shape: an event was cancelled on GCal
        // during the dead window and no webhook ever fired for it.
        await calendarSyncConfigsDAO.insertOne(makeConfig({ webhookExpiry: dayjs().subtract(3, 'day').toISOString(), syncToken: 'tok-1', timeZone: 'UTC' }));
        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'item-1',
            user: 'user-1',
            title: 'Winn admin-panel',
            status: 'calendar',
            timeStart: dayjs().add(1, 'day').toISOString(),
            timeEnd: dayjs().add(1, 'day').add(1, 'hour').toISOString(),
            calendarEventId: 'ev-1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'cfg-1',
            createdTs: now,
            updatedTs: now,
        });
        const { incrementalSpy } = stubProviderForCatchUp({
            events: [
                {
                    id: 'ev-1',
                    title: 'Winn admin-panel',
                    timeStart: dayjs().add(1, 'day').toISOString(),
                    timeEnd: dayjs().add(1, 'day').add(1, 'hour').toISOString(),
                    updated: dayjs().subtract(2, 'day').toISOString(),
                    status: 'cancelled',
                },
            ],
            nextSyncToken: 'tok-2',
        });

        const sseSpy = vi.spyOn(sseConnections, 'notifyUserViaSse');
        const webPushSpy = vi.spyOn(webPush, 'notifyViaWebPush').mockResolvedValue();

        await renewAllExpiring();

        expect(incrementalSpy).toHaveBeenCalledWith('primary', 'tok-1');
        const item = await itemsDAO.findOne({ _id: 'item-1' });
        expect(item?.status).toBe('trash');
        expect(item?.cancelledByGCal).toBe(true);
        const config = await calendarSyncConfigsDAO.findOne({ _id: 'cfg-1' });
        expect(config?.syncToken).toBe('tok-2');
        // The watch itself was re-registered too.
        expect(config?.webhookResourceId).toBe('res-fresh');
        expect(dayjs(config?.webhookExpiry).isAfter(dayjs())).toBe(true);
        // The trash produced ops → devices must be woken (SSE for live tabs, web push for closed ones).
        expect(sseSpy).toHaveBeenCalledWith('user-1', expect.objectContaining({ type: 'update' }));
        expect(webPushSpy).toHaveBeenCalledTimes(1);
    });

    it('heals an expired syncToken during catch-up: 410 → full sync + reconcile sweep trashes the stranded item', async () => {
        await seedUserEmail('user-1', 'alice@example.com');
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration({ status: 'active' }));
        await calendarSyncConfigsDAO.insertOne(
            makeConfig({ webhookExpiry: dayjs().subtract(30, 'day').toISOString(), syncToken: 'tok-stale', timeZone: 'UTC' }),
        );
        // Stranded item: its GCal event was deleted long ago, but the cancellation tombstone is no
        // longer replayable (expired token). Only the full-sync reconcile sweep can catch it.
        // updatedTs is well past the 120s reconcile grace window.
        await itemsDAO.insertOne({
            _id: 'item-stranded',
            user: 'user-1',
            title: 'Deleted long ago on GCal',
            status: 'calendar',
            timeStart: dayjs().add(1, 'day').toISOString(),
            timeEnd: dayjs().add(1, 'day').add(1, 'hour').toISOString(),
            calendarEventId: 'evgone1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'cfg-1',
            createdTs: dayjs().subtract(30, 'day').toISOString(),
            updatedTs: dayjs().subtract(3, 'day').toISOString(),
        });
        const { incrementalSpy, fullSpy } = stubProviderForCatchUp({ events: [], nextSyncToken: 'unused' });
        incrementalSpy.mockRejectedValue(new SyncTokenInvalidError());

        await renewAllExpiring();

        expect(fullSpy).toHaveBeenCalledTimes(1);
        const item = await itemsDAO.findOne({ _id: 'item-stranded' });
        expect(item?.status).toBe('trash');
        expect(item?.cancelledByGCal).toBe(true);
        const config = await calendarSyncConfigsDAO.findOne({ _id: 'cfg-1' });
        expect(config?.syncToken).toBe('tok-full');
    });

    it('treats a config with no webhook fields as lapsed — catch-up sync runs after the watch is established', async () => {
        await seedUserEmail('user-1', 'alice@example.com');
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration({ status: 'active' }));
        // No webhookExpiry at all (cleared fields / never set up) — a gap may exist; drain it.
        await calendarSyncConfigsDAO.insertOne(makeConfig({ syncToken: 'tok-1', timeZone: 'UTC' }));
        const { incrementalSpy } = stubProviderForCatchUp({ events: [], nextSyncToken: 'tok-2' });

        await renewAllExpiring();

        expect(incrementalSpy).toHaveBeenCalledWith('primary', 'tok-1');
        const config = await calendarSyncConfigsDAO.findOne({ _id: 'cfg-1' });
        expect(config?.syncToken).toBe('tok-2');
    });

    it('proactive renewal of a still-live channel does NOT sync — no gap existed', async () => {
        await seedUserEmail('user-1', 'alice@example.com');
        await calendarIntegrationsDAO.insertEncrypted(makeIntegration({ status: 'active' }));
        // Expiring within the 1-day horizon but not yet lapsed — webhooks are still flowing.
        await calendarSyncConfigsDAO.insertOne(makeConfig({ webhookExpiry: dayjs().add(2, 'hour').toISOString(), syncToken: 'tok-1', timeZone: 'UTC' }));
        const { incrementalSpy, fullSpy } = stubProviderForCatchUp({ events: [], nextSyncToken: 'tok-2' });
        const watchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents');
        const sseSpy = vi.spyOn(sseConnections, 'notifyUserViaSse');

        await renewAllExpiring();

        expect(watchSpy).toHaveBeenCalledTimes(1);
        expect(incrementalSpy).not.toHaveBeenCalled();
        expect(fullSpy).not.toHaveBeenCalled();
        expect(sseSpy).not.toHaveBeenCalled();
        const config = await calendarSyncConfigsDAO.findOne({ _id: 'cfg-1' });
        // syncToken untouched — only the watch was refreshed.
        expect(config?.syncToken).toBe('tok-1');
        expect(config?.webhookResourceId).toBe('res-fresh');
    });
});
