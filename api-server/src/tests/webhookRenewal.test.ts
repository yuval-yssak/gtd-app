/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts queried docs are present */
import dayjs from 'dayjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import sentEmailsDAO from '../dataAccess/sentEmailsDAO.js';
import { renewAllExpiring } from '../lib/webhookRenewal.js';
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
        // unawaited handleAuthFailure performs several Mongo round-trips (findById → markSuspended →
        // findById → sendEmail). Poll until the row is suspended rather than racing on a fixed delay.
        await waitFor(async () => (await calendarIntegrationsDAO.findById('int-1'))?.status === 'suspended');

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
        await waitFor(async () => (await calendarIntegrationsDAO.findById('int-B'))?.status === 'suspended');

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
