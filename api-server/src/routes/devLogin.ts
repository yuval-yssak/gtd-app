import { createHmac } from 'node:crypto';
import { generateId } from 'better-auth';
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { issueApiToken } from '../auth/apiTokens.js';
import { SESSION_COOKIE_NAME } from '../auth/constants.js';
import type { GCalEvent } from '../calendarProviders/CalendarProvider.js';
import apiTokensDAO from '../dataAccess/apiTokensDAO.js';
import { auth, db } from '../loaders/mainLoader.js';
import { deviceSyncStateId } from '../types/entities.js';

// Guard: this module must never be loaded in production — throw immediately if it slips through.
// The dynamic import in index.ts already prevents this; this is a belt-and-suspenders check.
if (process.env.NODE_ENV === 'production') {
    throw new Error('devLogin route must not be loaded in production');
}

const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Per-user cap for the dev-only POST /dev/api-tokens endpoint. Higher than the production cap
 * because rapid mint/revoke during local testing is normal — this is a safety net against
 * runaway loops, not a security boundary. Production cap (20) lives in `routes/tokens.ts` as
 * `PROD_TOKEN_CAP_PER_USER`. DO NOT extract into a shared constant; see issue #19 step 12.
 */
export const DEV_TOKEN_CAP_PER_USER = 50;

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
                db.collection('reviewInboxes').deleteMany({ user: { $in: userIds } } as never),
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
            db.collection('reviewInboxes').deleteMany({}),
            db.collection('deviceUsers').deleteMany({}),
            db.collection('pushSubscriptions').deleteMany({}),
            db.collection('calendarIntegrations').deleteMany({}),
            db.collection('calendarSyncConfigs').deleteMany({}),
        ]);
        return c.json({ ok: true, scope: 'all' });
    })

    // POST /dev/reap-device — delete deviceSyncState row(s) for a device, simulating the stale-device
    // reaper removing them while the device was offline. Lets Playwright drive the bootstrapRequired
    // 409 recovery flow without waiting STALE_DEVICE_DAYS. With `email`, only the (deviceId, user)
    // row for that user is removed; without, every user's row for the device goes. Auth-free like
    // the other dev helpers — the module is unmountable in production (see guard at top of file).
    .post('/reap-device', async (c) => {
        const { deviceId, email } = await c.req.json<{ deviceId: string; email?: string }>();
        if (!deviceId) {
            return c.json({ error: 'deviceId required' }, 400);
        }
        if (email) {
            const user = await db.collection<StoredUser>('user').findOne({ email: email.toLowerCase() });
            if (!user) {
                return c.json({ deletedRows: 0 });
            }
            const single = await db.collection('deviceSyncState').deleteOne({ _id: deviceSyncStateId(deviceId, user._id) } as never);
            return c.json({ deletedRows: single.deletedCount });
        }
        const all = await db.collection('deviceSyncState').deleteMany({ deviceId });
        return c.json({ deletedRows: all.deletedCount });
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
    // Alternatively filter by user / routineId / status (any combination) for assertions where the
    // server generated the entity and the test doesn't know its id (e.g. routine-seeded items).
    .get('/reassign/find-entity', async (c) => {
        const collection = c.req.query('collection');
        const filter = Object.fromEntries(
            (['entityId', 'user', 'routineId', 'status'] as const)
                .map((key) => [key === 'entityId' ? '_id' : key, c.req.query(key)])
                .filter(([, value]) => value !== undefined),
        );
        if (!collection || Object.keys(filter).length === 0) {
            return c.json({ error: 'collection and at least one of entityId/user/routineId/status required' }, 400);
        }
        if (!['items', 'routines', 'people', 'workContexts'].includes(collection)) {
            return c.json({ error: 'disallowed collection' }, 400);
        }
        const doc = await db.collection(collection).findOne(filter as never);
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
    // for e2e specs that need a calendar-linked item to move across accounts, without the
    // session-membership guard the production endpoint enforces. GCal side effects are op-driven
    // and asynchronous now (the orchestrator makes no provider calls of its own), so no provider
    // stub is needed: in the e2e environment the async pushback resolves against the seeded fake
    // integration and fails harmlessly (fire-and-forget, surfaced on the op row).
    .post('/calendar/simulate-event-move', async (c) => {
        const { reassignEntity } = await import('../lib/reassignEntity.js');
        const body = await c.req.json<{
            entityType: 'item' | 'routine' | 'person' | 'workContext';
            entityId: string;
            fromUserId: string;
            toUserId: string;
            targetCalendar?: { integrationId: string; syncConfigId: string };
        }>();
        const result = await reassignEntity(body);
        if (!result.ok) {
            return c.json({ error: result.error }, result.status);
        }
        return c.json({ ok: true, ...(result.alreadyMoved ? { alreadyMoved: true } : {}) });
    })

    // POST /dev/calendar/simulate-webhook-event — drives one inbound GCal event through the
    // single-event upsert path used by webhook delivery, without orchestrating a real Google
    // Calendar push subscription. Used by the revive-trashed-item e2e to confirm the inbound
    // anchor (`lastSyncedFromGCalTs`) restores items that were trashed by a prior disconnect.
    .post('/calendar/simulate-webhook-event', async (c) => {
        const { default: calendarIntegrationsDAO } = await import('../dataAccess/calendarIntegrationsDAO.js');
        const { default: calendarSyncConfigsDAO } = await import('../dataAccess/calendarSyncConfigsDAO.js');
        const { upsertCalendarItem } = await import('./calendar.js');
        const body = await c.req.json<{
            userId: string;
            integrationId: string;
            syncConfigId: string;
            event: { id: string; title: string; timeStart: string; timeEnd: string; updated: string; status: string; description?: string };
        }>();
        if (!body.userId || !body.integrationId || !body.syncConfigId || !body.event) {
            return c.json({ error: 'userId, integrationId, syncConfigId, event required' }, 400);
        }
        const integration = await calendarIntegrationsDAO.findOne({ _id: body.integrationId, user: body.userId });
        const config = await calendarSyncConfigsDAO.findOne({ _id: body.syncConfigId, user: body.userId });
        if (!integration || !config) {
            return c.json({ error: 'integration or syncConfig not found' }, 404);
        }
        const now = dayjs().toISOString();
        // `recordOperation` (called inside upsertCalendarItem) already writes ops to the DB; the
        // local ctx.ops list is just for tracking — no need to insert it again here. The explicit
        // type pin via Parameters<> avoids `ops: never[]` inference.
        const ctx: Parameters<typeof upsertCalendarItem>[2] = { userId: body.userId, now, ops: [] };
        await upsertCalendarItem(body.event, { integration, config }, ctx);
        return c.json({ ok: true, opsRecorded: ctx.ops.length });
    })

    // POST /dev/calendar/simulate-routine-exception — drives one inbound GCal recurring-instance
    // exception through `applyExceptionToItems`, the same path `syncRoutineExceptions` invokes for
    // each entry returned by `getExceptions`. Used by the "moved-twice" e2e to confirm the
    // calendarInstanceEventId lookup correctly finds an item whose `timeStart` was shifted by a
    // prior exception.
    //
    // Trust boundary: body.userId is accepted without a session check. Safe because the entire
    // devLogin module throws on load when NODE_ENV === 'production' (see top of file) AND
    // index.ts only mounts /dev when NODE_ENV !== 'production' — staging + prod both set
    // NODE_ENV=production, so this route is physically unreachable outside dev.
    .post('/calendar/simulate-routine-exception', async (c) => {
        const { default: routinesDAO } = await import('../dataAccess/routinesDAO.js');
        const { applyExceptionToItems } = await import('./calendar.js');
        const body = await c.req.json<{
            userId: string;
            routineId: string;
            exception: {
                originalDate: string;
                type: 'modified' | 'deleted';
                googleEventId?: string;
                newTimeStart?: string;
                newTimeEnd?: string;
                title?: string;
                notes?: string;
            };
        }>();
        if (!body.userId || !body.routineId || !body.exception) {
            return c.json({ error: 'userId, routineId, exception required' }, 400);
        }
        const routine = await routinesDAO.findByOwnerAndId(body.routineId, body.userId);
        if (!routine) {
            return c.json({ error: 'routine not found' }, 404);
        }
        const now = dayjs().toISOString();
        const ctx: Parameters<typeof applyExceptionToItems>[2] = { userId: body.userId, now, ops: [] };
        await applyExceptionToItems(routine, body.exception, ctx);
        return c.json({ ok: true, opsRecorded: ctx.ops.length });
    })

    // POST /dev/calendar/simulate-routine-exception-sync — drives the FULL routine-exception
    // reconcile path (`reconcileAndApplyRoutineExceptions`) with a caller-controlled `reported` set,
    // standing in for `provider.getExceptions` (which needs a live Google account). Used by the
    // skipped-exception revival e2e: seed a `skipped` exception + trashed item, then POST an EMPTY
    // `reported` array to simulate GCal dropping the cancellation tombstone → the occurrence revives.
    //
    // Trust boundary: same as simulate-routine-exception — dev-only module, unmountable in prod.
    .post('/calendar/simulate-routine-exception-sync', async (c) => {
        const { default: routinesDAO } = await import('../dataAccess/routinesDAO.js');
        const { reconcileAndApplyRoutineExceptions } = await import('./calendar.js');
        const body = await c.req.json<{
            userId: string;
            routineId: string;
            reported: Parameters<typeof reconcileAndApplyRoutineExceptions>[1];
            since?: string;
            timeZone?: string;
        }>();
        if (!body.userId || !body.routineId || !Array.isArray(body.reported)) {
            return c.json({ error: 'userId, routineId, reported[] required' }, 400);
        }
        const routine = await routinesDAO.findByOwnerAndId(body.routineId, body.userId);
        if (!routine) {
            return c.json({ error: 'routine not found' }, 404);
        }
        const now = dayjs().toISOString();
        // Default `since` to epoch so the reconcile window floor collapses to now-30d (the common
        // fresh-sync case); callers can override to exercise the cursor-bounded window.
        const since = body.since ?? '1970-01-01T00:00:00.000Z';
        const ctx: Parameters<typeof reconcileAndApplyRoutineExceptions>[3] = {
            userId: body.userId,
            now,
            ops: [],
            ...(body.timeZone ? { timeZone: body.timeZone } : {}),
        };
        await reconcileAndApplyRoutineExceptions(routine, body.reported, since, ctx);
        return c.json({ ok: true, opsRecorded: ctx.ops.length });
    })

    // POST /dev/calendar/simulate-backfill-relink — drives the relink-first backfill path
    // (`simulateBackfillRelink`) with a caller-supplied `masters` set standing in for
    // `provider.listEventsFull` (which needs a live Google account). Used by the
    // calendar-backfill-relink e2e: seed a naked routine + a real recurring master, then assert the
    // routine relinks onto the master instead of minting a `gtd*` clone. Mirrors the trust boundary
    // of the other simulate-* routes (dev-only module, unmountable in prod).
    .post('/calendar/simulate-backfill-relink', async (c) => {
        const { default: calendarIntegrationsDAO } = await import('../dataAccess/calendarIntegrationsDAO.js');
        const { default: calendarSyncConfigsDAO } = await import('../dataAccess/calendarSyncConfigsDAO.js');
        const { simulateBackfillRelink } = await import('./calendar.js');
        const body = await c.req.json<{
            userId: string;
            integrationId: string;
            syncConfigId: string;
            masters: Parameters<typeof simulateBackfillRelink>[0];
        }>();
        if (!body.userId || !body.integrationId || !body.syncConfigId || !Array.isArray(body.masters)) {
            return c.json({ error: 'userId, integrationId, syncConfigId, masters[] required' }, 400);
        }
        const integration = await calendarIntegrationsDAO.findOne({ _id: body.integrationId, user: body.userId });
        const config = await calendarSyncConfigsDAO.findOne({ _id: body.syncConfigId, user: body.userId });
        if (!integration || !config) {
            return c.json({ error: 'integration or syncConfig not found' }, 404);
        }
        const now = dayjs().toISOString();
        const ctx: Parameters<typeof simulateBackfillRelink>[2] = {
            userId: body.userId,
            now,
            ops: [],
            ...(config.timeZone ? { timeZone: config.timeZone } : {}),
        };
        const result = await simulateBackfillRelink(body.masters, { integration, config }, ctx);
        return c.json({ ok: true, ...result, opsRecorded: ctx.ops.length });
    })

    // POST /dev/calendar/simulate-relink-sweep — drives the active relink sweep
    // (`relinkStrandedMarkers`) with a caller-supplied event set standing in for `provider.getEvent`
    // (which needs a live Google account). GCal-write methods on the stub provider record their
    // calls into the response so specs can assert what would have been pushed. Used by the
    // calendar-relink-sweep e2e. Mirrors the trust boundary of the other simulate-* routes
    // (dev-only module, unmountable in prod).
    .post('/calendar/simulate-relink-sweep', async (c) => {
        const { default: calendarIntegrationsDAO } = await import('../dataAccess/calendarIntegrationsDAO.js');
        const { relinkStrandedMarkers } = await import('./calendar.js');
        const body = await c.req.json<{
            userId: string;
            integrationId: string;
            events: GCalEvent[];
        }>();
        if (!body.userId || !body.integrationId || !Array.isArray(body.events)) {
            return c.json({ error: 'userId, integrationId, events[] required' }, 400);
        }
        const integration = await calendarIntegrationsDAO.findOne({ _id: body.integrationId, user: body.userId });
        if (!integration) {
            return c.json({ error: 'integration not found' }, 404);
        }
        const pushedUpdates: Array<{ eventId: string; updates: unknown }> = [];
        const pushedCreates: Array<{ title: string; timeStart: string }> = [];
        const createdSeries: string[] = [];
        const stubProvider = {
            getEvent: async (_calendarId: string, eventId: string) => body.events.find((event) => event.id === eventId) ?? null,
            getCalendarTimeZone: async () => 'Asia/Jerusalem',
            updateEvent: async (_calendarId: string, eventId: string, updates: unknown) => {
                pushedUpdates.push({ eventId, updates });
            },
            createEvent: async (_calendarId: string, event: { title: string; timeStart: string }) => {
                pushedCreates.push({ title: event.title, timeStart: event.timeStart });
                return { eventId: `sim-recreated-${generateId(8)}` };
            },
            createRecurringEvent: async () => {
                const id = `sim-series-${generateId(8)}`;
                createdSeries.push(id);
                return id;
            },
        };
        // Cast through unknown is safe here — the sweep only calls the methods stubbed above on
        // this dev-only path (getEvent for resolution; update/create via the stubbed factory).
        type Provider = Parameters<typeof relinkStrandedMarkers>[1];
        const provider = stubProvider as unknown as Provider;
        const now = dayjs().toISOString();
        const ctx: Parameters<typeof relinkStrandedMarkers>[2] = { userId: body.userId, now, ops: [] };
        const result = await relinkStrandedMarkers(integration, provider, ctx, () => provider);
        return c.json({ ok: true, ...result, pushedUpdates, pushedCreates, createdSeries, opsRecorded: ctx.ops.length });
    })

    // POST /dev/api-tokens — issue a personal API token for the currently logged-in user.
    // Stand-in for a settings-page mint UI: the dev runs this from a browser/curl with their
    // session cookie and pastes the resulting plaintext into their MCP env file. Production has
    // its own mint endpoint at `POST /account/tokens` (session-authed via the SPA).
    .post('/api-tokens', async (c) => {
        const session = await auth.api.getSession({ headers: c.req.raw.headers });
        if (!session) {
            return c.json({ error: 'Unauthorized: log in first' }, 401);
        }
        // Dev-only safety net: cap mints per user so an accidental loop can't fill the collection.
        // DO NOT extract into a shared constant with `PROD_TOKEN_CAP_PER_USER` in `routes/tokens.ts`.
        // Dev (50) and prod (20) have different risk profiles — see issue #19 step 12 and the
        // tripwire test in `tests/tokenCapsAreSeparate.test.ts` that fails if these values converge.
        const existing = await db.collection('apiTokens').countDocuments({ user: session.user.id });
        if (existing >= DEV_TOKEN_CAP_PER_USER) {
            return c.json({ error: `Token cap reached (${DEV_TOKEN_CAP_PER_USER}). Revoke unused tokens before minting new ones.` }, 429);
        }
        const body = await c.req.json<{ label?: string }>().catch(() => ({}) as { label?: string });
        const label = body.label?.trim() || 'unlabeled';
        const { plaintext, record } = await issueApiToken(session.user.id, label);
        // plaintext is shown exactly once — caller is responsible for storing it.
        return c.json({ id: record._id, label: record.label, createdTs: record.createdTs, plaintext });
    })

    // POST /dev/api-tokens/:id/touch — override the apiToken row's lastUsedTs so e2e tests can
    // exercise the "unused" chip behaviour without waiting 90 days. Body: { lastUsedTs: ISO }.
    // Bypasses auth so the spec doesn't have to thread a session cookie through.
    .post('/api-tokens/:id/touch', async (c) => {
        const id = c.req.param('id');
        const body = await c.req.json<{ lastUsedTs?: string }>().catch(() => ({}) as { lastUsedTs?: string });
        if (typeof body.lastUsedTs !== 'string' || body.lastUsedTs.trim() === '') {
            return c.json({ error: 'lastUsedTs (ISO datetime string) required' }, 400);
        }
        const existing = await apiTokensDAO.findOne({ _id: id });
        if (!existing) {
            return c.json({ error: 'token not found' }, 404);
        }
        await apiTokensDAO.touchLastUsed(id, body.lastUsedTs);
        return c.json({ ok: true });
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
