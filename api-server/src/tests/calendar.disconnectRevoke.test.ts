/**
 * Step 3B: disconnecting a calendar integration tells Google the grant is over (best-effort),
 * so "disconnecting ends our access" in the privacy policy holds at Google's end too. The
 * partial-grant rejection in the OAuth callback must NOT revoke (it would kill a working
 * integration's refresh token on a same-account re-consent) — pinned in calendar.integrations.test.ts.
 */
import dayjs from 'dayjs';
import { describe, expect, it, vi } from 'vitest';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import { app, getUserId, insertIntegrationWithConfig, loginAsAlice, useCalendarTestLifecycle } from './calendarTestKit.js';
import { authenticatedRequest, revokedTokensFrom, stubGoogleRevokeEndpoint } from './helpers.js';

useCalendarTestLifecycle();

/**
 * Installs a console.log spy and returns a reader for the one line the disconnect writes about its
 * revoke. Installed per test because useCalendarTestLifecycle's restoreAllMocks lifts setup.ts's spy.
 */
function watchRevokeOutcome() {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    return () =>
        logSpy.mock.calls
            .map((args) => String(args[0]))
            .find((message) => message.startsWith('[calendar] disconnect revoke outcome'))
            ?.match(/outcome=(\w+)/)?.[1];
}

describe('DELETE /calendar/integrations/:id — Google grant revocation', () => {
    it('revokes the integration’s refresh token at Google, then deletes the rows', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const revokeOutcomeLogged = watchRevokeOutcome();
        await insertIntegrationWithConfig(userId, { refreshToken: 'rt-to-revoke', accessToken: 'at-kept' });
        const fetchSpy = stubGoogleRevokeEndpoint(200);

        const res = await authenticatedRequest(app, { method: 'DELETE', path: '/calendar/integrations/int-1?action=keepLinkedEntities', sessionCookie });
        expect(res.status).toBe(200);

        expect(revokedTokensFrom(fetchSpy)).toEqual(['rt-to-revoke']);
        expect(revokeOutcomeLogged()).toBe('revoked');
        expect(await calendarIntegrationsDAO.findByUserDecrypted(userId)).toEqual([]);
        expect(await calendarSyncConfigsDAO.findByIntegration('int-1')).toEqual([]);
    });

    it('does NOT revoke when another GTD user has connected the same Google account — their refresh token would die too', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const revokeOutcomeLogged = watchRevokeOutcome();
        await insertIntegrationWithConfig(userId, { accountEmail: 'shared@gmail.com' });
        await calendarIntegrationsDAO.insertEncrypted({
            _id: 'int-other-user',
            user: 'some-other-gtd-user',
            provider: 'google',
            accessToken: 'at2',
            refreshToken: 'rt2',
            tokenExpiry: dayjs().toISOString(),
            accountEmail: 'shared@gmail.com',
            createdTs: dayjs().toISOString(),
            updatedTs: dayjs().toISOString(),
        });
        const fetchSpy = stubGoogleRevokeEndpoint(200);

        const res = await authenticatedRequest(app, { method: 'DELETE', path: '/calendar/integrations/int-1?action=keepLinkedEntities', sessionCookie });
        expect(res.status).toBe(200);
        expect(revokedTokensFrom(fetchSpy)).toEqual([]);
        expect(revokeOutcomeLogged()).toBe('skipped_shared_account');
        expect(await calendarIntegrationsDAO.findByUserDecrypted(userId)).toEqual([]);
        // The other user's integration is untouched.
        expect(await calendarIntegrationsDAO.findByUserDecrypted('some-other-gtd-user')).toHaveLength(1);
    });

    it('still disconnects when Google rejects the revocation', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const revokeOutcomeLogged = watchRevokeOutcome();
        await insertIntegrationWithConfig(userId);
        stubGoogleRevokeEndpoint(400);

        const res = await authenticatedRequest(app, { method: 'DELETE', path: '/calendar/integrations/int-1?action=keepLinkedEntities', sessionCookie });
        expect(res.status).toBe(200);
        // Google's 400 means the grant is already gone — the goal state, logged as such.
        expect(revokeOutcomeLogged()).toBe('already_revoked');
        expect(await calendarIntegrationsDAO.findByUserDecrypted(userId)).toEqual([]);
    });

    it('still disconnects when the revocation request itself fails', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const revokeOutcomeLogged = watchRevokeOutcome();
        await insertIntegrationWithConfig(userId);
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));

        const res = await authenticatedRequest(app, { method: 'DELETE', path: '/calendar/integrations/int-1?action=removeLinkedEntities', sessionCookie });
        expect(res.status).toBe(200);
        expect(revokeOutcomeLogged()).toBe('failed');
        expect(await calendarIntegrationsDAO.findByUserDecrypted(userId)).toEqual([]);
    });
});
