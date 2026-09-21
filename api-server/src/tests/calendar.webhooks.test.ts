/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import dayjs from 'dayjs';
import { describe, expect, it, vi } from 'vitest';
import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import { app, getUserId, insertIntegrationWithConfig, loginAsAlice, makeIntegration, makeSyncConfig, useCalendarTestLifecycle } from './calendarTestKit.js';
import { authenticatedRequest } from './helpers.js';

useCalendarTestLifecycle();

// ─── Webhook receiver ──────────────────────────────────────────────────────

describe('POST /calendar/webhooks/google', () => {
    it('returns 400 when required headers are missing', async () => {
        const res = await app.fetch(new Request('http://localhost:4000/calendar/webhooks/google', { method: 'POST' }));
        expect(res.status).toBe(400);
    });

    it('returns 200 on sync handshake (resource-state: sync)', async () => {
        const res = await app.fetch(
            new Request('http://localhost:4000/calendar/webhooks/google', {
                method: 'POST',
                headers: { 'x-goog-channel-id': 'ch-1', 'x-goog-resource-id': 'res-1', 'x-goog-resource-state': 'sync' },
            }),
        );
        expect(res.status).toBe(200);
    });

    it('returns 404 for unknown channel ID', async () => {
        const res = await app.fetch(
            new Request('http://localhost:4000/calendar/webhooks/google', {
                method: 'POST',
                headers: { 'x-goog-channel-id': 'unknown', 'x-goog-resource-id': 'res-1', 'x-goog-resource-state': 'exists' },
            }),
        );
        expect(res.status).toBe(404);
    });

    it('returns 404 when resourceId does not match', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-99', 'res-correct', dayjs().add(7, 'day').toISOString());

        const res = await app.fetch(
            new Request('http://localhost:4000/calendar/webhooks/google', {
                method: 'POST',
                headers: { 'x-goog-channel-id': 'ch-99', 'x-goog-resource-id': 'res-wrong', 'x-goog-resource-state': 'exists' },
            }),
        );
        expect(res.status).toBe(404);
    });

    it('triggers sync and returns 200 for a valid notification', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-valid', 'res-valid', dayjs().add(7, 'day').toISOString());

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok-wh' });

        const res = await app.fetch(
            new Request('http://localhost:4000/calendar/webhooks/google', {
                method: 'POST',
                headers: { 'x-goog-channel-id': 'ch-valid', 'x-goog-resource-id': 'res-valid', 'x-goog-resource-state': 'exists' },
            }),
        );
        expect(res.status).toBe(200);

        // Give the fire-and-forget sync a moment to complete.
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Verify the syncToken was persisted by the webhook-triggered sync.
        const config = await calendarSyncConfigsDAO.findByOwnerAndId('sync-config-1', userId);
        expect(config!.syncToken).toBe('tok-wh');
    });

    it('releases the channel lock when the sync throws, so the next webhook is not coalesced forever', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-throw', 'res-throw', dayjs().add(7, 'day').toISOString());

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        // First webhook delivery: listEventsFull throws — this used to leak the in-memory channel lock
        // (channelStates stuck at 'running'), permanently jamming the channel until process restart.
        const listEventsSpy = vi
            .spyOn(GoogleCalendarProvider.prototype, 'listEventsFull')
            .mockRejectedValueOnce(new Error('boom — simulated MongoDB E11000 inside sync'))
            .mockResolvedValueOnce({ events: [], nextSyncToken: 'tok-after-throw' });

        const makeWebhookRequest = () =>
            app.fetch(
                new Request('http://localhost:4000/calendar/webhooks/google', {
                    method: 'POST',
                    headers: { 'x-goog-channel-id': 'ch-throw', 'x-goog-resource-id': 'res-throw', 'x-goog-resource-state': 'exists' },
                }),
            );

        const res1 = await makeWebhookRequest();
        expect(res1.status).toBe(200);

        // Wait for the first (throwing) sync to settle and release the lock.
        await new Promise((resolve) => setTimeout(resolve, 100));

        const res2 = await makeWebhookRequest();
        expect(res2.status).toBe(200);

        // Wait for the second sync to complete.
        await new Promise((resolve) => setTimeout(resolve, 200));

        // The second webhook must have started a fresh sync (not been coalesced) — proving the lock was
        // released even though the first sync threw. Both calls land on listEventsFull.
        expect(listEventsSpy).toHaveBeenCalledTimes(2);

        // And the second sync's syncToken was persisted, confirming end-to-end recovery.
        const config = await calendarSyncConfigsDAO.findByOwnerAndId('sync-config-1', userId);
        expect(config!.syncToken).toBe('tok-after-throw');
    });

    it('releases the channel lock even when a delivery was queued during the throwing sync', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-throw-q', 'res-throw-q', dayjs().add(7, 'day').toISOString());

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        // First listEventsFull: slow + throws. The second webhook arrives while this one is in flight,
        // so the lock transitions running → queued before the throw. Naive cleanup (finishWebhookSync
        // in the catch) would leave state at 'running' with no runner, jamming the channel until a
        // second post-error delivery arrives. delete()-based cleanup recovers on the very next delivery.
        const listEventsSpy = vi
            .spyOn(GoogleCalendarProvider.prototype, 'listEventsFull')
            .mockImplementationOnce(async () => {
                await new Promise((resolve) => setTimeout(resolve, 100));
                throw new Error('boom — simulated MongoDB E11000 inside sync');
            })
            .mockResolvedValueOnce({ events: [], nextSyncToken: 'tok-after-throw-q' });

        const makeWebhookRequest = () =>
            app.fetch(
                new Request('http://localhost:4000/calendar/webhooks/google', {
                    method: 'POST',
                    headers: { 'x-goog-channel-id': 'ch-throw-q', 'x-goog-resource-id': 'res-throw-q', 'x-goog-resource-state': 'exists' },
                }),
            );

        // Fire deliveries 1 and 2 back-to-back so #2 arrives while #1's sync is still running.
        const res1 = await makeWebhookRequest();
        const res2 = await makeWebhookRequest();
        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);

        // Wait for the first (throwing) sync to settle and clear the lock.
        await new Promise((resolve) => setTimeout(resolve, 250));

        // Now fire delivery 3 — it must start a fresh sync, not be coalesced into a phantom queue.
        const res3 = await makeWebhookRequest();
        expect(res3.status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Two spy calls: the throwing one (delivery 1) and the recovery one (delivery 3). Delivery 2
        // is correctly dropped — its queued re-run never runs because we don't drain queues on error.
        expect(listEventsSpy).toHaveBeenCalledTimes(2);

        // Delivery 3 persisted its syncToken — end-to-end recovery confirmed.
        const config = await calendarSyncConfigsDAO.findByOwnerAndId('sync-config-1', userId);
        expect(config!.syncToken).toBe('tok-after-throw-q');
    });

    it('coalesces concurrent notifications into one in-flight sync plus one queued re-run', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-coalesce', 'res-coalesce', dayjs().add(7, 'day').toISOString());

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        // Make listEventsFull slow enough that the second webhook arrives while the first sync is still running.
        const listEventsSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { events: [], nextSyncToken: 'tok-coalesce' };
        });

        const makeWebhookRequest = () =>
            app.fetch(
                new Request('http://localhost:4000/calendar/webhooks/google', {
                    method: 'POST',
                    headers: { 'x-goog-channel-id': 'ch-coalesce', 'x-goog-resource-id': 'res-coalesce', 'x-goog-resource-state': 'exists' },
                }),
            );

        // Three rapid-fire deliveries: the first starts a sync, the next two coalesce into one queued re-run.
        const res1 = await makeWebhookRequest();
        const res2 = await makeWebhookRequest();
        const res3 = await makeWebhookRequest();
        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);
        expect(res3.status).toBe(200);

        // Wait long enough for both the in-flight sync and the queued re-run to complete (50ms each + buffer).
        await new Promise((resolve) => setTimeout(resolve, 300));

        // Two syncs total: the immediate one and one coalesced re-run covering deliveries 2 and 3.
        expect(listEventsSpy).toHaveBeenCalledTimes(2);
    });
});

// ─── Webhook renewal ───────────────────────────────────────────────────────

describe('POST /calendar/webhooks/renew', () => {
    it('returns 401 without the cron secret', async () => {
        const res = await app.fetch(new Request('http://localhost:4000/calendar/webhooks/renew', { method: 'POST' }));
        expect(res.status).toBe(401);
    });

    it('returns 401 with wrong cron secret', async () => {
        const res = await app.fetch(
            new Request('http://localhost:4000/calendar/webhooks/renew', {
                method: 'POST',
                headers: { 'x-cron-secret': 'wrong-secret' },
            }),
        );
        expect(res.status).toBe(401);
    });

    it('renews expiring webhook channels', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Set webhook fields with an expiry within the 1-day renewal horizon.
        const soonExpiry = dayjs().add(6, 'hour').toISOString();
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-old', 'res-old', soonExpiry);

        vi.spyOn(GoogleCalendarProvider.prototype, 'stopWatch').mockResolvedValue(undefined);
        vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({
            resourceId: 'res-new',
            expiration: dayjs().add(7, 'day').toISOString(),
        });

        const secret = 'test-cron-secret';
        process.env.CRON_SECRET = secret;
        process.env.CALENDAR_WEBHOOK_URL = 'https://example.com/webhooks/google';

        try {
            const res = await app.fetch(
                new Request('http://localhost:4000/calendar/webhooks/renew', {
                    method: 'POST',
                    headers: { 'x-cron-secret': secret },
                }),
            );
            expect(res.status).toBe(200);
            const body = (await res.json()) as { renewed: number; failed: number };
            expect(body.renewed).toBe(1);
            expect(body.failed).toBe(0);

            // Verify the new webhook fields were persisted.
            const config = await calendarSyncConfigsDAO.findByOwnerAndId('sync-config-1', userId);
            expect(config!.webhookResourceId).toBe('res-new');
        } finally {
            delete process.env.CRON_SECRET;
            delete process.env.CALENDAR_WEBHOOK_URL;
        }
    });
});

// ─── Watch setup/teardown on sync config CRUD ──────────────────────────────

describe('webhook watch lifecycle', () => {
    it('sets up a watch when creating a sync config', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const integration = makeIntegration(userId);
        await calendarIntegrationsDAO.insertEncrypted(integration);
        await calendarSyncConfigsDAO.insertOne(makeSyncConfig(userId, integration._id));

        process.env.CALENDAR_WEBHOOK_URL = 'https://example.com/webhooks/google';
        const watchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({
            resourceId: 'res-created',
            expiration: dayjs().add(7, 'day').toISOString(),
        });

        try {
            const res = await authenticatedRequest(app, {
                method: 'POST',
                path: '/calendar/integrations/int-1/sync-configs',
                sessionCookie,
                body: { calendarId: 'work' },
            });
            expect(res.status).toBe(201);
            expect(watchSpy).toHaveBeenCalledOnce();
        } finally {
            delete process.env.CALENDAR_WEBHOOK_URL;
        }
    });

    it('tears down watch when deleting a sync config', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-del', 'res-del', dayjs().add(7, 'day').toISOString());

        const stopSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'stopWatch').mockResolvedValue(undefined);

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1/sync-configs/sync-config-1',
            sessionCookie,
        });
        expect(res.status).toBe(200);
        expect(stopSpy).toHaveBeenCalledWith('ch-del', 'res-del');
    });

    it('tears down watch when disabling a sync config', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-dis', 'res-dis', dayjs().add(7, 'day').toISOString());

        const stopSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'stopWatch').mockResolvedValue(undefined);

        const res = await authenticatedRequest(app, {
            method: 'PATCH',
            path: '/calendar/integrations/int-1/sync-configs/sync-config-1',
            sessionCookie,
            body: { enabled: false },
        });
        expect(res.status).toBe(200);
        expect(stopSpy).toHaveBeenCalledWith('ch-dis', 'res-dis');
    });

    it('renews expired webhook during manual sync', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Set webhook as expired (in the past).
        const expiredExpiry = dayjs().subtract(1, 'hour').toISOString();
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-expired', 'res-expired', expiredExpiry);

        process.env.CALENDAR_WEBHOOK_URL = 'https://example.com/webhooks/google';
        const stopSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'stopWatch').mockResolvedValue(undefined);
        const watchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({
            resourceId: 'res-renewed',
            expiration: dayjs().add(7, 'day').toISOString(),
        });
        // setupWatch now stops the stale channel itself, so renew no longer tears down (which would
        // clear the fields) before re-registering — pin that "one fewer DB write" simplification.
        const clearSpy = vi.spyOn(calendarSyncConfigsDAO, 'clearWebhookFields');
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok' });

        try {
            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            // Old channel should be stopped and new one created — without clearing fields mid-renew.
            expect(stopSpy).toHaveBeenCalledWith('ch-expired', 'res-expired');
            expect(watchSpy).toHaveBeenCalledOnce();
            expect(clearSpy).not.toHaveBeenCalled();
            const config = await calendarSyncConfigsDAO.findByOwnerAndId('sync-config-1', userId);
            expect(config?.webhookResourceId).toBe('res-renewed');
        } finally {
            delete process.env.CALENDAR_WEBHOOK_URL;
        }
    });

    it('sets up webhook during manual sync when config has no webhook fields', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Config has no webhook fields at all — simulates initial setup or cleared state.

        process.env.CALENDAR_WEBHOOK_URL = 'https://example.com/webhooks/google';
        const stopSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'stopWatch').mockResolvedValue(undefined);
        const watchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({
            resourceId: 'res-fresh',
            expiration: dayjs().add(7, 'day').toISOString(),
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok' });

        try {
            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            // Should set up without tearing down (no existing channel).
            expect(stopSpy).not.toHaveBeenCalled();
            expect(watchSpy).toHaveBeenCalledOnce();
            const config = await calendarSyncConfigsDAO.findByOwnerAndId('sync-config-1', userId);
            expect(config!.webhookResourceId).toBe('res-fresh');
        } finally {
            delete process.env.CALENDAR_WEBHOOK_URL;
        }
    });

    it('skips webhook renewal when not expiring', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Set webhook with a far-future expiry.
        const farExpiry = dayjs().add(6, 'day').toISOString();
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-ok', 'res-ok', farExpiry);

        process.env.CALENDAR_WEBHOOK_URL = 'https://example.com/webhooks/google';
        const stopSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'stopWatch').mockResolvedValue(undefined);
        const watchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({
            resourceId: 'res-new',
            expiration: dayjs().add(7, 'day').toISOString(),
        });
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({ events: [], nextSyncToken: 'tok' });

        try {
            const res = await authenticatedRequest(app, { method: 'POST', path: '/calendar/integrations/int-1/sync', sessionCookie });
            expect(res.status).toBe(200);
            // Webhook is still valid — no renewal should happen.
            expect(stopSpy).not.toHaveBeenCalled();
            expect(watchSpy).not.toHaveBeenCalled();
        } finally {
            delete process.env.CALENDAR_WEBHOOK_URL;
        }
    });

    it('sets up watch when re-enabling a sync config', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Start with config disabled.
        await calendarSyncConfigsDAO.updateOne({ _id: 'sync-config-1' } as never, { $set: { enabled: false } });

        process.env.CALENDAR_WEBHOOK_URL = 'https://example.com/webhooks/google';
        const watchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({
            resourceId: 'res-reenable',
            expiration: dayjs().add(7, 'day').toISOString(),
        });

        try {
            const res = await authenticatedRequest(app, {
                method: 'PATCH',
                path: '/calendar/integrations/int-1/sync-configs/sync-config-1',
                sessionCookie,
                body: { enabled: true },
            });
            expect(res.status).toBe(200);
            expect(watchSpy).toHaveBeenCalledOnce();
        } finally {
            delete process.env.CALENDAR_WEBHOOK_URL;
        }
    });

    it('stops a stale channel before re-registering when a re-enabled config still carries webhook fields', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Disabled config that STILL carries webhook fields from a prior enable cycle (or a config
        // row that survived a disconnect+reconnect). Pre-fix, re-enabling minted a fresh channel
        // and left 'ch-stale' live on Google → an orphan that kept firing (the storm's leak).
        await calendarSyncConfigsDAO.updateOne({ _id: 'sync-config-1' } as never, { $set: { enabled: false } });
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-stale', 'res-stale', dayjs().add(7, 'day').toISOString());

        process.env.CALENDAR_WEBHOOK_URL = 'https://example.com/webhooks/google';
        const stopSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'stopWatch').mockResolvedValue(undefined);
        const watchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'watchEvents').mockResolvedValue({
            resourceId: 'res-fresh',
            expiration: dayjs().add(7, 'day').toISOString(),
        });

        try {
            const res = await authenticatedRequest(app, {
                method: 'PATCH',
                path: '/calendar/integrations/int-1/sync-configs/sync-config-1',
                sessionCookie,
                body: { enabled: true },
            });
            expect(res.status).toBe(200);
            // The stale channel must be stopped on Google's side before the new one is registered.
            expect(stopSpy).toHaveBeenCalledWith('ch-stale', 'res-stale');
            expect(watchSpy).toHaveBeenCalledOnce();
            const config = await calendarSyncConfigsDAO.findByOwnerAndId('sync-config-1', userId);
            expect(config?.webhookChannelId).not.toBe('ch-stale');
            expect(config?.webhookResourceId).toBe('res-fresh');
        } finally {
            delete process.env.CALENDAR_WEBHOOK_URL;
        }
    });

    it('tears down all watches when deleting an integration', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch-int-del', 'res-int-del', dayjs().add(7, 'day').toISOString());

        const stopSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'stopWatch').mockResolvedValue(undefined);

        const res = await authenticatedRequest(app, {
            method: 'DELETE',
            path: '/calendar/integrations/int-1',
            sessionCookie,
        });
        expect(res.status).toBe(200);
        expect(stopSpy).toHaveBeenCalledWith('ch-int-del', 'res-int-del');
    });
});
