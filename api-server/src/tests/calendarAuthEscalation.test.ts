/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts mock call indices are present */
import dayjs from 'dayjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import sentEmailsDAO from '../dataAccess/sentEmailsDAO.js';
import { handleAuthFailure } from '../lib/calendarAuthEscalation.js';
import * as emailStub from '../lib/emailStub.js';
import * as userLookup from '../lib/userLookup.js';
import type { CalendarIntegrationInterface } from '../types/entities.js';

// Frozen wall-clock anchor — `dayjs()` reads `Date.now()`, so vi.useFakeTimers + setSystemTime makes
// elapsed-time calculations in the escalation logic deterministic across the suspended-grace branch.
const T0 = '2026-05-01T12:00:00.000Z';

function makeIntegration(overrides: Partial<CalendarIntegrationInterface> = {}): CalendarIntegrationInterface {
    return {
        _id: 'int-1',
        user: 'user-1',
        provider: 'google',
        accessToken: 'at',
        refreshToken: 'rt',
        tokenExpiry: T0,
        createdTs: T0,
        updatedTs: T0,
        ...overrides,
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('handleAuthFailure', () => {
    it('transitions active → suspended and sends a warning email', async () => {
        const integration = makeIntegration({ status: 'active' });
        vi.spyOn(calendarIntegrationsDAO, 'findById')
            .mockResolvedValueOnce(integration)
            .mockResolvedValueOnce({ ...integration, status: 'suspended', suspendedAt: T0, lastAuthErrorAt: T0 });
        const markSpy = vi.spyOn(calendarIntegrationsDAO, 'markSuspendedIfActive').mockResolvedValueOnce(true);
        vi.spyOn(userLookup, 'getUserEmail').mockResolvedValue('alice@example.com');
        const sendSpy = vi.spyOn(emailStub, 'sendEmail').mockResolvedValue();

        await handleAuthFailure('int-1');

        expect(markSpy).toHaveBeenCalledWith('int-1', T0);
        expect(sendSpy).toHaveBeenCalledTimes(1);
        expect(sendSpy.mock.calls[0]![0].kind).toBe('calendar_auth_warning');
        expect(sendSpy.mock.calls[0]![0].to).toBe('alice@example.com');
    });

    it('treats a row with no status field as active (legacy lazy default)', async () => {
        const integration = makeIntegration({ status: undefined });
        vi.spyOn(calendarIntegrationsDAO, 'findById')
            .mockResolvedValueOnce(integration)
            .mockResolvedValueOnce({ ...integration, status: 'suspended' });
        const markSpy = vi.spyOn(calendarIntegrationsDAO, 'markSuspendedIfActive').mockResolvedValueOnce(true);
        vi.spyOn(userLookup, 'getUserEmail').mockResolvedValue('alice@example.com');
        vi.spyOn(emailStub, 'sendEmail').mockResolvedValue();

        await handleAuthFailure('int-1');

        expect(markSpy).toHaveBeenCalledTimes(1);
    });

    it('only bumps lastAuthErrorAt when suspended and grace has not elapsed', async () => {
        const suspendedAt = dayjs(T0).subtract(1, 'hour').toISOString();
        const integration = makeIntegration({ status: 'suspended', suspendedAt });
        vi.spyOn(calendarIntegrationsDAO, 'findById').mockResolvedValueOnce(integration);
        const bumpSpy = vi.spyOn(calendarIntegrationsDAO, 'bumpLastAuthErrorAt').mockResolvedValueOnce(undefined);
        const revokeSpy = vi.spyOn(calendarIntegrationsDAO, 'markRevokedIfSuspended');
        const sendSpy = vi.spyOn(emailStub, 'sendEmail');

        await handleAuthFailure('int-1');

        expect(bumpSpy).toHaveBeenCalledWith('int-1', T0);
        expect(revokeSpy).not.toHaveBeenCalled();
        expect(sendSpy).not.toHaveBeenCalled();
    });

    it('transitions suspended → revoked and sends final email when grace elapsed', async () => {
        const suspendedAt = dayjs(T0).subtract(25, 'hour').toISOString();
        const integration = makeIntegration({ status: 'suspended', suspendedAt });
        vi.spyOn(calendarIntegrationsDAO, 'findById')
            .mockResolvedValueOnce(integration)
            .mockResolvedValueOnce({ ...integration, status: 'revoked', revokedAt: T0 });
        const revokeSpy = vi.spyOn(calendarIntegrationsDAO, 'markRevokedIfSuspended').mockResolvedValueOnce(true);
        vi.spyOn(userLookup, 'getUserEmail').mockResolvedValue('alice@example.com');
        const sendSpy = vi.spyOn(emailStub, 'sendEmail').mockResolvedValue();

        await handleAuthFailure('int-1');

        expect(revokeSpy).toHaveBeenCalledWith('int-1', T0);
        expect(sendSpy).toHaveBeenCalledTimes(1);
        expect(sendSpy.mock.calls[0]![0].kind).toBe('calendar_auth_revoked');
    });

    it('is a no-op for revoked integrations', async () => {
        const integration = makeIntegration({ status: 'revoked' });
        vi.spyOn(calendarIntegrationsDAO, 'findById').mockResolvedValueOnce(integration);
        const markSpy = vi.spyOn(calendarIntegrationsDAO, 'markSuspendedIfActive');
        const revokeSpy = vi.spyOn(calendarIntegrationsDAO, 'markRevokedIfSuspended');
        const sendSpy = vi.spyOn(emailStub, 'sendEmail');

        await handleAuthFailure('int-1');

        expect(markSpy).not.toHaveBeenCalled();
        expect(revokeSpy).not.toHaveBeenCalled();
        expect(sendSpy).not.toHaveBeenCalled();
    });

    it('warns and skips email when user has no email on record', async () => {
        const integration = makeIntegration({ status: 'active' });
        vi.spyOn(calendarIntegrationsDAO, 'findById')
            .mockResolvedValueOnce(integration)
            .mockResolvedValueOnce({ ...integration, status: 'suspended' });
        vi.spyOn(calendarIntegrationsDAO, 'markSuspendedIfActive').mockResolvedValueOnce(true);
        vi.spyOn(userLookup, 'getUserEmail').mockResolvedValue(null);
        const sendSpy = vi.spyOn(emailStub, 'sendEmail');

        await handleAuthFailure('int-1');

        expect(sendSpy).not.toHaveBeenCalled();
    });

    it('sends exactly one warning email when two concurrent calls race on an active integration', async () => {
        // Both calls observe `active` on the entry read, but only the first markSuspendedIfActive
        // returns true. The loser recurses into the suspended branch; with a fresh suspendedAt
        // of "now", the grace is unfilled so it bumps lastAuthErrorAt instead of sending a second
        // email.
        const integration = makeIntegration({ status: 'active' });
        const suspended = { ...integration, status: 'suspended' as const, suspendedAt: T0 };

        // Track read sequence per (handleAuthFailure call) — within a single call, the first read
        // returns active and the post-mark read returns suspended. Two parallel calls each follow
        // that pattern independently, but the second mark loses the race so its loser-branch reads
        // also see suspended.
        const reads: Array<CalendarIntegrationInterface> = [
            { ...integration, status: 'active' }, // call A entry read
            { ...integration, status: 'active' }, // call B entry read
            suspended, // call A post-mark read (sender side)
            suspended, // call B recursion entry read (loser path)
            suspended, // call B post-loser-suspended read (bump branch — no second post-read needed, but harmless)
        ];
        let readIdx = 0;
        vi.spyOn(calendarIntegrationsDAO, 'findById').mockImplementation(async () => reads[Math.min(readIdx++, reads.length - 1)] ?? null);

        const markSpy = vi.spyOn(calendarIntegrationsDAO, 'markSuspendedIfActive').mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        const bumpSpy = vi.spyOn(calendarIntegrationsDAO, 'bumpLastAuthErrorAt').mockResolvedValue(undefined);
        vi.spyOn(userLookup, 'getUserEmail').mockResolvedValue('alice@example.com');
        const sendSpy = vi.spyOn(emailStub, 'sendEmail').mockResolvedValue();

        await Promise.all([handleAuthFailure('int-1'), handleAuthFailure('int-1')]);

        expect(markSpy).toHaveBeenCalledTimes(2);
        expect(bumpSpy).toHaveBeenCalledTimes(1);
        expect(sendSpy).toHaveBeenCalledTimes(1);
        expect(sendSpy.mock.calls[0]![0].kind).toBe('calendar_auth_warning');
    });
});

// The escalation module imports `db` from mainLoader, which requires loadDataAccess() to run.
// Since this file only mocks DAOs and never actually persists, we don't need a live Mongo connection
// — the DAO methods we exercise are all mocked above. But the userLookup module reads `db` at call
// time; we mock userLookup wholesale to avoid that path. The sentEmailsDAO reference inside emailStub
// is only used when sendEmail is *not* mocked; here we mock sendEmail too. So no Mongo needed.
void sentEmailsDAO; // keep the import to surface schema regressions at compile time
