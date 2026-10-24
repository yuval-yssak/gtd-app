import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice, withTwoAccountsOnOneDevice } from './helpers/context';
import { API_URL } from './helpers/env';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// Better Auth's multiSession plugin sets each account's `_multi-<token>` cookie once, at sign-in,
// and never refreshes it, so every account on a device used to be signed out a fixed time after
// sign-in however actively it synced. The server now re-issues the cookie on every pivot. Here the
// secondary account's cookie is an hour from expiring; one sync pass must push it back out.
//
// A lone account without a multi-session cookie is never pivoted, so its cookie is renewed only by
// the auth middleware forwarding the Set-Cookie Better Auth emits when a request slides the session.

const SESSION_COOKIE_NAME = 'better-auth.session_token';
const MULTI_COOKIE_PREFIX = `${SESSION_COOKIE_NAME}_multi-`;
const DEV_SESSION_EXPIRY_URL = `${API_URL}/dev/session-expiry`;
const DAY_SECONDS = 24 * 60 * 60;

/** Moves the user's DB sessions inside Better Auth's refresh window (expiresIn 7d − updateAge 1d). */
async function moveSessionsIntoRefreshWindow(email: string) {
    const res = await fetch(DEV_SESSION_EXPIRY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, expiresInSeconds: DAY_SECONDS }),
    });
    if (!res.ok) {
        throw new Error(`dev/session-expiry ${res.status}: ${await res.text()}`);
    }
}

test.describe('multi-session cookie renewal', () => {
    test('a sync pass renews a secondary account cookie that was about to expire', async ({ browser }) => {
        const stamp = uniqueStamp();
        const emails: [string, string] = [`renew-a-${stamp}@example.com`, `renew-b-${stamp}@example.com`];

        await withTwoAccountsOnOneDevice(browser, emails, async (page, { secondary }) => {
            const context = page.context();
            const secondaryCookieName = `${MULTI_COOKIE_PREFIX}${secondary.rawToken.toLowerCase()}`;
            const findSecondaryCookie = async () => (await context.cookies()).find((c) => c.name === secondaryCookieName);

            const original = await findSecondaryCookie();
            if (!original) throw new Error('expected the secondary account multi-session cookie');
            await context.addCookies([{ ...original, expires: dayjs().add(1, 'hour').unix() }]);

            // Each pass pivots to every account in IDB via /auth/multi-session/set-active. The secondary
            // only joins IDB once useAccounts lists the device sessions after boot, so keep syncing until
            // its pivot has run. Dev sessions are seeded with 30 days left; the renewal tracks that lifetime.
            await expect
                .poll(async () => {
                    await gtd.pull(page);
                    return (await findSecondaryCookie())?.expires ?? 0;
                })
                .toBeGreaterThan(dayjs().add(25, 'day').unix());
            await expect(page.getByText('Sync is broken for an account')).toHaveCount(0);
        });
    });

    test('a sync request renews the session cookie of a lone account the sync never pivots', async ({ browser }) => {
        const email = `renew-lone-${uniqueStamp()}@example.com`;

        await withOneLoggedInDevice(browser, email, async (page) => {
            const context = page.context();
            const findSessionCookie = async () => (await context.cookies()).find((c) => c.name === SESSION_COOKIE_NAME);

            const original = await findSessionCookie();
            if (!original) throw new Error('expected the session cookie');
            await moveSessionsIntoRefreshWindow(email);
            await context.addCookies([{ ...original, expires: dayjs().add(1, 'hour').unix() }]);

            await gtd.pull(page);

            expect((await findSessionCookie())?.expires).toBeGreaterThan(dayjs().add(6, 'day').unix());
        });
    });
});
