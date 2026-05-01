import { createHmac } from 'node:crypto';
import { generateId } from 'better-auth';
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { SESSION_COOKIE_NAME } from '../auth/constants.js';
import { auth, db } from '../loaders/mainLoader.js';

// Guard: this module must never be loaded in production — throw immediately if it slips through.
// The dynamic import in index.ts already prevents this; this is a belt-and-suspenders check.
if (process.env.NODE_ENV === 'production') {
    throw new Error('devLogin route must not be loaded in production');
}

const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Replicates better-call's signCookieValue + encodeURIComponent wrapping.
// Format: encodeURIComponent("rawToken.base64(HMAC-SHA256(rawToken, secret))")
// Buffer.from(..., 'utf8') ensures encoding matches Web Crypto's TextEncoder used by Better Auth.
function signSessionToken(rawToken: string, secret: string): string {
    const sig = createHmac('sha256', Buffer.from(secret, 'utf8')).update(Buffer.from(rawToken, 'utf8')).digest('base64');
    return encodeURIComponent(`${rawToken}.${sig}`);
}

// Auth options are set before any request is served (loadDataAccess runs first).
function readAuthSecret(): string {
    return (
        (auth as unknown as { options: { secret?: string } }).options?.secret ?? process.env.BETTER_AUTH_SECRET ?? 'dev_better_auth_secret_change_in_production'
    );
}

// Shape of a user document as stored by the Better Auth MongoDB adapter.
interface StoredUser {
    _id: string;
    email: string;
}

// Atomic upsert user by email — reuse the existing ID so repeated logins share one user.
// Uses findOneAndUpdate to avoid a TOCTOU race when two devices log in concurrently
// with the same email (parallel loginAs calls in e2e tests).
async function getOrCreateUserId(normalizedEmail: string): Promise<string> {
    const userId = generateId(32);
    const now = dayjs().toDate();
    const result = await db.collection<StoredUser>('user').findOneAndUpdate(
        { email: normalizedEmail },
        {
            $setOnInsert: {
                _id: userId,
                name: normalizedEmail.split('@')[0],
                email: normalizedEmail,
                emailVerified: false,
                image: null,
                createdAt: now,
                updatedAt: now,
            } as never,
        },
        { upsert: true, returnDocument: 'after' },
    );
    if (!result) {
        throw new Error('Failed to create or retrieve user');
    }
    return result._id;
}

export const devLoginRoutes = new Hono()
    // POST /dev/login — upsert a user by email and create a valid Better Auth session.
    // Returns the signed cookie in both Set-Cookie (for browser-side use) and JSON body
    // (easier for the Playwright helper to parse into context.addCookies() format).
    .post('/login', async (c) => {
        const { email } = await c.req.json<{ email: string }>();
        const normalizedEmail = email.toLowerCase();

        const userId = await getOrCreateUserId(normalizedEmail);

        // Create a new session — rawToken is what goes into the signed cookie.
        const rawToken = generateId(32);
        const sessionId = generateId(32);
        const now = dayjs();
        const expiresAt = now.add(SESSION_EXPIRY_MS, 'ms');

        await db.collection('session').insertOne({
            _id: sessionId,
            userId,
            token: rawToken,
            // MongoDB stores these as BSON Date — .toDate() converts from dayjs
            expiresAt: expiresAt.toDate(),
            createdAt: now.toDate(),
            updatedAt: now.toDate(),
            ipAddress: '',
            userAgent: 'playwright-e2e',
        } as never);

        const signedToken = signSessionToken(rawToken, readAuthSecret());

        c.header('Set-Cookie', `${SESSION_COOKIE_NAME}=${signedToken}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toDate().toUTCString()}`);

        return c.json({
            ok: true,
            userId,
            email: normalizedEmail,
            // Playwright's BrowserContext.addCookies() format — returned to avoid parsing Set-Cookie.
            cookie: {
                name: SESSION_COOKIE_NAME,
                value: signedToken,
                domain: 'localhost',
                path: '/',
                httpOnly: true,
                secure: false,
                sameSite: 'Lax' as const,
                expires: expiresAt.unix(), // Unix seconds for Playwright
            },
        });
    })

    // POST /dev/multi-login — produce cookies for *several* accounts on a single browser context.
    // Better Auth's multiSession plugin keeps additional sessions in `better-auth.session_token_multi-<token>`
    // cookies; the active session lives at `better-auth.session_token`. We mirror that format
    // so e2e tests can preload a context with two simultaneous accounts without driving the
    // OAuth + addAnotherAccount UI flow.
    .post('/multi-login', async (c) => {
        const { emails, activeIndex = 0 } = await c.req.json<{ emails: string[]; activeIndex?: number }>();
        if (!Array.isArray(emails) || emails.length === 0) {
            return c.json({ error: 'emails array required' }, 400);
        }
        if (activeIndex < 0 || activeIndex >= emails.length) {
            return c.json({ error: 'activeIndex out of range' }, 400);
        }

        const secret = readAuthSecret();
        const now = dayjs();
        const expiresAt = now.add(SESSION_EXPIRY_MS, 'ms');

        // Provision a fresh session for each email — userId is reused via the email upsert
        // so repeated calls for the same email don't create duplicate Better Auth users.
        const sessions = await Promise.all(
            emails.map(async (email) => {
                const normalizedEmail = email.toLowerCase();
                const userId = await getOrCreateUserId(normalizedEmail);
                const rawToken = generateId(32);
                const sessionId = generateId(32);
                await db.collection('session').insertOne({
                    _id: sessionId,
                    userId,
                    token: rawToken,
                    expiresAt: expiresAt.toDate(),
                    createdAt: now.toDate(),
                    updatedAt: now.toDate(),
                    ipAddress: '',
                    userAgent: 'playwright-e2e',
                } as never);
                return { email: normalizedEmail, userId, rawToken, signedToken: signSessionToken(rawToken, secret) };
            }),
        );

        // Cookie shape Playwright's BrowserContext.addCookies expects.
        const baseCookie = {
            domain: 'localhost',
            path: '/',
            httpOnly: true,
            secure: false,
            sameSite: 'Lax' as const,
            expires: expiresAt.unix(),
        };

        const active = sessions[activeIndex];
        if (!active) {
            // unreachable given the activeIndex validation above; satisfies noUncheckedIndexedAccess
            return c.json({ error: 'invalid activeIndex' }, 400);
        }

        // Each session also lives at `<sessionTokenName>_multi-<rawToken_lowercased>`. The cookie
        // value must be the SIGNED token (matches setSignedCookie behaviour in the multiSession hook).
        const cookies = [
            { ...baseCookie, name: SESSION_COOKIE_NAME, value: active.signedToken },
            ...sessions.map((s) => ({
                ...baseCookie,
                name: `${SESSION_COOKIE_NAME}_multi-${s.rawToken.toLowerCase()}`,
                value: s.signedToken,
            })),
        ];

        return c.json({
            ok: true,
            // Raw token included so e2e tests can pivot to a different session via Better Auth's
            // /auth/multi-session/set-active endpoint (which expects the raw, unsigned token).
            sessions: sessions.map((s) => ({ email: s.email, userId: s.userId, rawToken: s.rawToken })),
            cookies,
        });
    })

    // DELETE /dev/reset — wipe collections so tests can start with a clean slate.
    //
    // Two modes:
    //   - Body `{ emails: [...] }` — scoped reset: only delete records owned by users with those
    //     emails. Safe to run while other workers are using unrelated emails. Specs running in
    //     parallel MUST use this form so /dev/reset in one file doesn't wipe sessions/items
    //     belonging to a test running concurrently in another worker.
    //   - No body — global wipe: kept for one-off manual cleanup. Parallel e2e runs must not use
    //     this form (it will clobber concurrent workers); helpers/context.ts:resetServerForEmails
    //     always sends an `emails` body for that reason.
    .delete('/reset', async (c) => {
        const body = await c.req.json<{ emails?: string[] } | undefined>().catch(() => undefined);
        const emails = body?.emails?.map((e) => e.toLowerCase());
        if (emails && emails.length > 0) {
            const users = await db
                .collection<{ _id: string; email: string }>('user')
                .find({ email: { $in: emails } })
                .toArray();
            const userIds = users.map((u) => u._id);
            // Best-effort: if no users matched, the only thing to clear is potential leftover state
            // keyed by email (none of our collections are). Return ok so tests proceed idempotently.
            if (userIds.length === 0) {
                return c.json({ ok: true, scope: 'emails', deletedUserIds: [] });
            }
            await Promise.all([
                db.collection('user').deleteMany({ _id: { $in: userIds } } as never),
                db.collection('session').deleteMany({ userId: { $in: userIds } } as never),
                db.collection('items').deleteMany({ user: { $in: userIds } } as never),
                db.collection('operations').deleteMany({ user: { $in: userIds } } as never),
                db.collection('deviceSyncState').deleteMany({ user: { $in: userIds } } as never),
                db.collection('routines').deleteMany({ user: { $in: userIds } } as never),
                db.collection('people').deleteMany({ user: { $in: userIds } } as never),
                db.collection('workContexts').deleteMany({ user: { $in: userIds } } as never),
                db.collection('deviceUsers').deleteMany({ userId: { $in: userIds } } as never),
                db.collection('pushSubscriptions').deleteMany({ user: { $in: userIds } } as never),
                db.collection('calendarIntegrations').deleteMany({ user: { $in: userIds } } as never),
                db.collection('calendarSyncConfigs').deleteMany({ user: { $in: userIds } } as never),
            ]);
            return c.json({ ok: true, scope: 'emails', deletedUserIds: userIds });
        }
        await Promise.all([
            db.collection('user').deleteMany({}),
            db.collection('session').deleteMany({}),
            db.collection('items').deleteMany({}),
            db.collection('operations').deleteMany({}),
            db.collection('deviceSyncState').deleteMany({}),
            db.collection('routines').deleteMany({}),
            db.collection('people').deleteMany({}),
            db.collection('workContexts').deleteMany({}),
            db.collection('deviceUsers').deleteMany({}),
            db.collection('pushSubscriptions').deleteMany({}),
            db.collection('calendarIntegrations').deleteMany({}),
            db.collection('calendarSyncConfigs').deleteMany({}),
        ]);
        return c.json({ ok: true, scope: 'all' });
    })

    // GET /dev/device-users?deviceId=... — surface deviceUsers join rows so e2e specs can
    // assert which (deviceId, userId) pairs the server has recorded without reaching into
    // MongoDB directly. Auth-free because tests need to read the collection across sign-out
    // boundaries; safe because the route is only registered in non-production builds.
    .get('/device-users', async (c) => {
        const deviceId = c.req.query('deviceId');
        if (!deviceId) {
            return c.json({ error: 'deviceId query param required' }, 400);
        }
        const rows = await db.collection<{ _id: string; deviceId: string; userId: string }>('deviceUsers').find({ deviceId }).toArray();
        return c.json({ rows: rows.map((r) => ({ deviceId: r.deviceId, userId: r.userId })) });
    })

    // POST /dev/drop-push-subscription — simulate a server-side subscription loss so the
    // Settings page can be exercised against a {registered:false} response without going
    // through the actual 410-from-Apple-or-Google fan-out path.
    .post('/drop-push-subscription', async (c) => {
        const { deviceId } = await c.req.json<{ deviceId: string }>();
        if (!deviceId) {
            return c.json({ error: 'deviceId required' }, 400);
        }
        // `as never` on _id matches the pattern in pushSubscriptionsDAO — driver widens _id to ObjectId.
        await db.collection('pushSubscriptions').deleteOne({ _id: deviceId } as never);
        return c.json({ ok: true });
    })

    // POST /dev/calendar/seed-integration — encrypted-token variant. Step 2 e2e specs hit
    // GET /calendar/integrations (which decrypts tokens), so the seed must round-trip through
    // calendarIntegrationsDAO.upsertEncrypted. `calendars` is optional: omit it to test the
    // "no calendar selected" Settings state, pass an array to test disconnect with linked items.
    .post('/calendar/seed-integration', async (c) => {
        // Lazy-import the DAO to avoid loading the encryption module unless this dev path is hit.
        const { default: calendarIntegrationsDAO } = await import('../dataAccess/calendarIntegrationsDAO.js');
        const { default: calendarSyncConfigsDAO } = await import('../dataAccess/calendarSyncConfigsDAO.js');
        const body = await c.req.json<{
            userId: string;
            integrationId?: string;
            calendars?: Array<{ configId?: string; calendarId: string; displayName?: string; isDefault?: boolean }>;
        }>();
        if (!body.userId) {
            return c.json({ error: 'userId required' }, 400);
        }
        const integrationId = body.integrationId ?? generateId(32);
        const now = dayjs().toISOString();
        await calendarIntegrationsDAO.upsertEncrypted({
            _id: integrationId,
            user: body.userId,
            provider: 'google',
            accessToken: 'dev-at-plaintext',
            refreshToken: 'dev-rt-plaintext',
            tokenExpiry: dayjs().add(1, 'hour').toISOString(),
            createdTs: now,
            updatedTs: now,
        });
        const configs = (body.calendars ?? []).map((calendar) => ({
            _id: calendar.configId ?? generateId(32),
            integrationId,
            user: body.userId,
            calendarId: calendar.calendarId,
            ...(calendar.displayName ? { displayName: calendar.displayName } : {}),
            isDefault: calendar.isDefault ?? false,
            enabled: true,
            createdTs: now,
            updatedTs: now,
        }));
        for (const config of configs) {
            await calendarSyncConfigsDAO.insertOne(config);
        }
        return c.json({ ok: true, integrationId, configIds: configs.map((cfg) => cfg._id) });
    })

    // GET /dev/calendar/simulate-mismatch — drives the OAuth callback's mismatch redirect
    // server-side without orchestrating the real Google OAuth flow (which can't be driven in
    // headless Chromium). Mirrors the production code path: revokes nothing (no real tokens
    // to revoke) and redirects to /settings?calendarConnectError=mismatch. GET (not POST) so
    // a Playwright `page.goto(...)` works as a top-level navigation.
    .get('/calendar/simulate-mismatch', (c) => {
        const clientUrl = process.env.CLIENT_URL ?? 'http://localhost:4173';
        return c.redirect(`${clientUrl}/settings?calendarConnectError=mismatch`);
    })

    // GET /dev/reassign/find-entity?collection=items&entityId=... — read a single entity by _id
    // for e2e assertions that need to verify server-side state without poking MongoDB directly.
    .get('/reassign/find-entity', async (c) => {
        const collection = c.req.query('collection');
        const entityId = c.req.query('entityId');
        if (!collection || !entityId) {
            return c.json({ error: 'collection and entityId required' }, 400);
        }
        if (!['items', 'routines', 'people', 'workContexts'].includes(collection)) {
            return c.json({ error: 'disallowed collection' }, 400);
        }
        const doc = await db.collection(collection).findOne({ _id: entityId } as never);
        return c.json({ doc });
    })

    // POST /dev/reassign/seed-entity — direct MongoDB insert + op record so e2e devices that
    // already bootstrapped past the entity's createdTs still pull it on the next /sync/pull.
    // Without the op record, the device's incremental pull cursor would skip the seed entirely.
    // Bypasses auth because dev routes are non-production-only.
    .post('/reassign/seed-entity', async (c) => {
        const { collection, doc } = await c.req.json<{ collection: string; doc: Record<string, unknown> & { _id: string; user: string } }>();
        const collectionToEntityType: Record<string, 'item' | 'routine' | 'person' | 'workContext'> = {
            items: 'item',
            routines: 'routine',
            people: 'person',
            workContexts: 'workContext',
        };
        const entityType = collectionToEntityType[collection];
        if (!entityType) {
            return c.json({ error: `disallowed collection: ${collection}` }, 400);
        }
        await db.collection(collection).insertOne(doc as never);
        // Record an op so the device's next pull surfaces the seeded entity.
        const now = dayjs().toISOString();
        await db.collection('operations').insertOne({
            _id: generateId(32),
            user: doc.user,
            deviceId: 'dev-seed',
            ts: now,
            entityType,
            entityId: doc._id,
            opType: 'create',
            snapshot: doc,
        } as never);
        return c.json({ ok: true });
    })

    // POST /dev/calendar/simulate-event-move — exercises the full /sync/reassign DB-side semantics
    // without calling Google Calendar. Used by e2e specs that need a calendar-linked item to move
    // across accounts (real GCal can't be driven from headless Chromium). Mirrors the production
    // endpoint's payload shape: accepts the same body and runs the same `reassignEntity` helper,
    // but stubs `buildCalendarProvider` so create/delete on the provider become no-ops.
    .post('/calendar/simulate-event-move', async (c) => {
        const { reassignEntity } = await import('../lib/reassignEntity.js');
        const body = await c.req.json<{
            entityType: 'item' | 'routine' | 'person' | 'workContext';
            entityId: string;
            fromUserId: string;
            toUserId: string;
            targetCalendar?: { integrationId: string; syncConfigId: string };
            simulatedEventId?: string;
        }>();
        const fakeEventId = body.simulatedEventId ?? `sim-${generateId(16)}`;
        // Stub provider mirrors only the methods reassignEntity actually invokes — createEvent
        // returns the simulated event id and deleteEvent is a no-op. The unused interface methods
        // throw so an unexpected call surfaces immediately rather than silently succeeding.
        const stubProvider = {
            createEvent: async () => fakeEventId,
            deleteEvent: async () => {},
            getCalendarTimeZone: async () => 'UTC',
            // Methods that aren't expected to be called in this dev path — surface programming errors loudly.
            updateEvent: () => {
                throw new Error('stub: updateEvent not implemented');
            },
            updateRecurringInstance: () => {
                throw new Error('stub: updateRecurringInstance not implemented');
            },
            cancelRecurringInstance: () => {
                throw new Error('stub: cancelRecurringInstance not implemented');
            },
            createRecurringEvent: () => {
                throw new Error('stub: createRecurringEvent not implemented');
            },
            updateRecurringEvent: () => {
                throw new Error('stub: updateRecurringEvent not implemented');
            },
            deleteRecurringEvent: () => {
                throw new Error('stub: deleteRecurringEvent not implemented');
            },
            capRecurringEvent: () => {
                throw new Error('stub: capRecurringEvent not implemented');
            },
            listEventsIncremental: () => {
                throw new Error('stub: listEventsIncremental not implemented');
            },
            listCalendars: () => {
                throw new Error('stub: listCalendars not implemented');
            },
            renewWebhook: () => {
                throw new Error('stub: renewWebhook not implemented');
            },
            stopWebhook: () => {
                throw new Error('stub: stopWebhook not implemented');
            },
        };
        // Cast through unknown is safe here — `reassignEntity` only calls the three methods stubbed
        // above (createEvent / deleteEvent / getCalendarTimeZone) on this dev-only code path.
        type ProviderFactoryType = Parameters<typeof reassignEntity>[1];
        const factory: ProviderFactoryType = () => stubProvider as unknown as ReturnType<ProviderFactoryType>;
        const result = await reassignEntity(body, factory);
        if (!result.ok) {
            return c.json({ error: result.error }, result.status);
        }
        return c.json({ ok: true, simulatedEventId: fakeEventId, ...(result.crossUserReferences ? { crossUserReferences: result.crossUserReferences } : {}) });
    })

    // GET /dev/calendar/integrations?userId=... — read calendarIntegrations rows for a user
    // bypassing the auth middleware. Used by e2e tests to assert disconnect actually removed
    // the row, without forging a session cookie.
    .get('/calendar/integrations', async (c) => {
        const userId = c.req.query('userId');
        if (!userId) {
            return c.json({ error: 'userId query param required' }, 400);
        }
        // Typed shape so we can read `user` with dot notation under noPropertyAccessFromIndexSignature.
        const rows = await db.collection<{ _id: string; user: string }>('calendarIntegrations').find({ user: userId }).toArray();
        return c.json({ rows: rows.map((r) => ({ _id: r._id, user: r.user })) });
    });
