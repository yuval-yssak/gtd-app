import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(utc);
dayjs.extend(timezone);

import { google } from 'googleapis';
import { Hono } from 'hono';
import { authenticateRequest } from '../auth/middleware.js';
import type { EventSyncResult, GCalEvent, GCalException } from '../calendarProviders/CalendarProvider.js';
import { SyncTokenInvalidError } from '../calendarProviders/CalendarProvider.js';
import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import { clientUrl } from '../config.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { propagateRoutineNotesToItems } from '../lib/calendarItemNotes.js';
import { ensureTimeZone } from '../lib/calendarPushback.js';
import { htmlToMarkdown, markdownToHtml } from '../lib/markdownHtml.js';
import { recordOperation } from '../lib/operationHelpers.js';
import { extractUntilFromRrule } from '../lib/rruleHelpers.js';
import { notifyUserViaSse } from '../lib/sseConnections.js';
import { hasAtLeastOne } from '../lib/typeUtils.js';
import { notifyViaWebPush } from '../lib/webPush.js';
import type { AuthVariables } from '../types/authTypes.js';
import type {
    CalendarIntegrationInterface,
    CalendarSyncConfigInterface,
    ItemInterface,
    OperationInterface,
    RoutineInterface,
    RoutineItemTemplate,
} from '../types/entities.js';

type UnlinkAction = 'keepEvents' | 'deleteEvents' | 'deleteAll';
type SyncContext = { userId: string; now: string; ops: OperationInterface[] };
type RoutineSyncCtx = { userId: string; since: string; now: string; calendarId: string; ops: OperationInterface[] };
type UnlinkSideEffectCtx = { provider: GoogleCalendarProvider; calendarId: string; userId: string; now: string };
/** Groups the integration + sync config identity needed by import/upsert functions. */
type CalendarSource = { integration: CalendarIntegrationInterface; config: CalendarSyncConfigInterface };
// Discriminated union to distinguish network failures from missing-token responses in the OAuth flow.
type OAuthTokenResult =
    | { ok: true; accessToken: string; refreshToken: string; expiryDate: number | null | undefined }
    | { ok: false; reason: 'exchange_failed' | 'missing_tokens' };

// ISO date string pattern — used to validate originalDate before building MongoDB queries.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 5 seconds is enough for the push→GCal→webhook roundtrip (< 2s typical). Kept short
// because `lastSyncedNotes` provides a second layer of protection: even if an echo leaks
// through, `resolveInboundNotes` will detect the description hasn't actually changed.
const ECHO_WINDOW_SECONDS = 5;

/** Returns true if the GCal event's `updated` timestamp falls within the echo window of a recent app push. */
function isOwnEcho(lastPushedTs: string, eventUpdated: string): boolean {
    return Math.abs(dayjs(eventUpdated).diff(dayjs(lastPushedTs), 'second')) < ECHO_WINDOW_SECONDS;
}

/** Returns true if the event has fully ended (timeEnd is strictly before `now`). */
function isPastEvent(event: { timeStart: string; timeEnd: string }, now: string): boolean {
    return dayjs(event.timeEnd).isBefore(dayjs(now));
}

const calendarRoutes = new Hono<{ Variables: AuthVariables }>();

// ── OAuth ─────────────────────────────────────────────────────────────────────

function buildOAuthClient() {
    return new google.auth.OAuth2(
        process.env.GOOGLE_OAUTH_APP_CLIENT_ID,
        process.env.GOOGLE_OAUTH_APP_CLIENT_SECRET,
        `${process.env.BETTER_AUTH_URL ?? 'http://localhost:4000'}/calendar/auth/google/callback`,
    );
}

function authSecret(): string {
    return process.env.BETTER_AUTH_SECRET ?? 'dev_better_auth_secret_change_in_production';
}

/** Signs a state payload with HMAC-SHA256 to prevent CSRF / userId injection in the OAuth callback. */
function signState(userId: string): string {
    const payload = JSON.stringify({ userId });
    const sig = createHmac('sha256', authSecret()).update(payload).digest('hex');
    return Buffer.from(JSON.stringify({ payload, sig })).toString('base64url');
}

/**
 * Parses and base64url-decodes the outer state envelope.
 * Wrapped in its own function so verifyState can use const — JSON.parse throws on invalid input.
 */
function parseStateEnvelope(stateParam: string): { payload: string; sig: string } {
    try {
        return JSON.parse(Buffer.from(stateParam, 'base64url').toString('utf8')) as { payload: string; sig: string };
    } catch {
        throw new Error('Malformed state parameter');
    }
}

/** Verifies the HMAC signature and extracts userId. Throws if the signature is invalid. */
function verifyState(stateParam: string): string {
    // JSON.parse is wrapped in parseStateEnvelope — a non-JSON or non-base64url value would
    // otherwise produce an uncaught SyntaxError that Hono turns into a 500 instead of a 400.
    const { payload, sig } = parseStateEnvelope(stateParam);
    const expected = createHmac('sha256', authSecret()).update(payload).digest('hex');
    // timingSafeEqual prevents timing attacks that could leak the expected HMAC byte-by-byte.
    const sigBuf = Buffer.from(sig, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
        throw new Error('Invalid state signature');
    }
    try {
        return (JSON.parse(payload) as { userId: string }).userId;
    } catch {
        throw new Error('Malformed state payload');
    }
}

/**
 * Exchanges an OAuth authorization code for tokens.
 * Returns a discriminated union so callers can map each failure mode to the right HTTP response
 * without wrapping a second try/catch around the call.
 */
/** Wraps verifyState so the OAuth callback can use const — verifyState throws, which would require a let across a try/catch. */
function tryVerifyState(stateParam: string): string | null {
    try {
        return verifyState(stateParam);
    } catch {
        return null;
    }
}

async function tryExchangeOAuthTokens(oauth2: ReturnType<typeof buildOAuthClient>, code: string): Promise<OAuthTokenResult> {
    try {
        const { tokens } = await oauth2.getToken(code);
        if (!tokens.access_token || !tokens.refresh_token) {
            return { ok: false, reason: 'missing_tokens' };
        }
        return { ok: true, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiryDate: tokens.expiry_date };
    } catch {
        return { ok: false, reason: 'exchange_failed' };
    }
}

calendarRoutes.get('/auth/google', authenticateRequest, (c) => {
    const oauth2 = buildOAuthClient();
    const userId = c.get('session').user.id;

    // state is HMAC-signed so the callback can verify it wasn't tampered with.
    const url = oauth2.generateAuthUrl({
        access_type: 'offline', // request refresh token
        prompt: 'consent', // always show consent screen so we always get a refresh token
        scope: ['https://www.googleapis.com/auth/calendar'],
        state: signState(userId),
    });

    return c.redirect(url);
});

calendarRoutes.get('/auth/google/callback', async (c) => {
    const code = c.req.query('code');
    const stateParam = c.req.query('state');
    if (!code || !stateParam) {
        return c.text('Missing code or state', 400);
    }

    const userId = tryVerifyState(stateParam);
    if (!userId) {
        return c.text('Invalid state parameter', 400);
    }

    const oauth2 = buildOAuthClient();
    const tokenResult = await tryExchangeOAuthTokens(oauth2, code);
    if (!tokenResult.ok) {
        return tokenResult.reason === 'missing_tokens'
            ? c.text('OAuth did not return required tokens', 400)
            : c.text('Failed to exchange OAuth code for tokens', 502);
    }
    const { accessToken, refreshToken, expiryDate } = tokenResult;

    const now = dayjs().toISOString();
    const integration: CalendarIntegrationInterface = {
        _id: randomUUID(),
        user: userId,
        provider: 'google',
        accessToken,
        refreshToken,
        tokenExpiry: expiryDate ? dayjs(expiryDate).toISOString() : dayjs().add(1, 'hour').toISOString(),
        // calendarId is set to 'primary' initially; the user can change it in settings.
        calendarId: 'primary',
        createdTs: now,
        updatedTs: now,
    };

    await calendarIntegrationsDAO.upsertEncrypted(integration);

    // Redirect back to client settings page so the user sees the new integration.
    return c.redirect(`${clientUrl}/settings?calendarConnected=1`);
});

// ── Provider factory ─────────────────────────────────────────────────────────

/** Creates a GoogleCalendarProvider that persists refreshed tokens back to MongoDB. */
function buildProvider(integration: CalendarIntegrationInterface, userId: string): GoogleCalendarProvider {
    return new GoogleCalendarProvider(integration, (accessToken, refreshToken, expiry) =>
        calendarIntegrationsDAO.updateTokens({ id: integration._id, userId, accessToken, refreshToken, tokenExpiry: expiry }),
    );
}

/** Fetches the timezone from Google and updates the sync config if it changed or was never cached. */
async function refreshTimeZone(config: CalendarSyncConfigInterface, provider: GoogleCalendarProvider): Promise<void> {
    const timeZone = await provider.getCalendarTimeZone(config.calendarId);
    if (timeZone !== config.timeZone) {
        await calendarSyncConfigsDAO.upsertTimeZone(config._id, timeZone);
        // Keep in-memory object in sync with DB so downstream readers see the fresh value.
        (config as { timeZone: string }).timeZone = timeZone;
    }
}

/** Returns the cached timezone for a calendar, or fetches it from Google and caches it on the default sync config. */
async function resolveTimeZoneForIntegration(integrationId: string, provider: GoogleCalendarProvider, calendarId: string): Promise<string> {
    const configs = await calendarSyncConfigsDAO.findEnabledByIntegration(integrationId);
    const config = configs.find((c) => c.calendarId === calendarId) ?? configs.find((c) => c.isDefault);
    if (!config) {
        return provider.getCalendarTimeZone(calendarId);
    }
    return ensureTimeZone(config, provider);
}

// ── Integration management ────────────────────────────────────────────────────

calendarRoutes.get('/integrations', authenticateRequest, async (c) => {
    const userId = c.get('session').user.id;
    const integrations = await calendarIntegrationsDAO.findByUserDecrypted(userId);
    // Lazy migration: ensure each integration has at least one CalendarSyncConfig.
    // Existing integrations created before multi-calendar support have only a calendarId field
    // but no sync config document — create one transparently on first load.
    await Promise.all(integrations.map((integration) => ensureSyncConfigExists(integration)));
    // Strip sensitive token fields from the response.
    const safe = integrations.map(({ accessToken: _a, refreshToken: _r, ...rest }) => rest);
    return c.json(safe);
});

/** Deletes the Google Calendar recurring event for each routine that has one. Errors are swallowed — the integration is removed regardless. */
async function deleteLinkedCalendarEvents(provider: GoogleCalendarProvider, routines: RoutineInterface[], calendarId: string): Promise<void> {
    await Promise.all(
        routines.flatMap((r) => {
            if (!r.calendarEventId) {
                return [];
            }
            return [provider.deleteRecurringEvent(r.calendarEventId, calendarId).catch(() => {})];
        }),
    );
}

/** Moves all items belonging to the given routine IDs to 'trash' and records operations so other devices learn about the deletion. */
async function trashRoutineItems(userId: string, routineIds: string[], now: string): Promise<void> {
    if (!hasAtLeastOne(routineIds)) {
        return;
    }
    await itemsDAO.updateMany({ user: userId, routineId: { $in: routineIds } }, { $set: { status: 'trash', updatedTs: now } });
    // Fetch after the write so operation snapshots reflect the persisted state, not stale pre-update reads.
    const trashedItems = await itemsDAO.findArray({ user: userId, routineId: { $in: routineIds } });
    await Promise.all(
        trashedItems.flatMap((item) => {
            const itemId = item._id;
            if (!itemId) {
                return [];
            }
            return [recordOperation(userId, { entityType: 'item', entityId: itemId, snapshot: item, opType: 'update', now })];
        }),
    );
}

/** Handles calendar-side cleanup based on the unlink action: deletes GCal events and/or trashes generated items. */
async function applyUnlinkSideEffects(action: UnlinkAction, routines: RoutineInterface[], ctx: UnlinkSideEffectCtx): Promise<void> {
    if (action === 'deleteEvents' || action === 'deleteAll') {
        await deleteLinkedCalendarEvents(ctx.provider, routines, ctx.calendarId);
    }
    if (action === 'deleteAll') {
        await trashRoutineItems(
            ctx.userId,
            routines.map((r) => r._id),
            ctx.now,
        );
    }
}

/** Clears calendarEventId and calendarIntegrationId from routines in the DB and records operations so other devices sync the cleared fields. */
async function unlinkRoutines(userId: string, routines: RoutineInterface[], now: string): Promise<void> {
    await Promise.all(
        routines.map((r) =>
            routinesDAO.updateOne(
                { _id: r._id, user: userId },
                { $unset: { calendarEventId: '', calendarIntegrationId: '', calendarSyncConfigId: '' }, $set: { updatedTs: now } },
            ),
        ),
    );
    // Record the unlinked state so other devices learn about the cleared calendarEventId/calendarIntegrationId.
    // TOCTOU note: the updateOne + findByOwnerAndId pair is non-atomic; a concurrent write between
    // the two could produce a snapshot that doesn't match the persisted document. This is an
    // accepted trade-off — MongoDB lacks multi-document transactions in this codebase, and the
    // sync pull's last-write-wins merge will reconcile any discrepancy on the next pull.
    await Promise.all(
        routines.map(async (r) => {
            const updated = await routinesDAO.findByOwnerAndId(r._id, userId);
            if (updated) {
                await recordOperation(userId, { entityType: 'routine', entityId: r._id, snapshot: updated, opType: 'update', now });
            }
        }),
    );
}

calendarRoutes.delete('/integrations/:id', authenticateRequest, async (c) => {
    const userId = c.get('session').user.id;
    const integrationId = c.req.param('id');
    const action = (c.req.query('action') ?? 'keepEvents') as UnlinkAction;

    const integration = await calendarIntegrationsDAO.findByOwnerAndIdDecrypted(integrationId, userId);
    if (!integration) {
        return c.json({ error: 'Integration not found' }, 404);
    }

    const now = dayjs().toISOString();
    const provider = buildProvider(integration, userId);
    const linkedRoutines = await routinesDAO.findArray({ user: userId, calendarIntegrationId: integrationId });

    await applyUnlinkSideEffects(action, linkedRoutines, { provider, calendarId: integration.calendarId, userId, now });
    await unlinkRoutines(userId, linkedRoutines, now);
    // Stop all webhook channels before deleting configs so Google stops sending notifications.
    const configs = await calendarSyncConfigsDAO.findByIntegration(integrationId);
    await Promise.all(configs.map((cfg) => teardownWatch(cfg, provider).catch(() => {})));
    await calendarSyncConfigsDAO.deleteByIntegration(integrationId);
    await calendarIntegrationsDAO.deleteByOwner(integrationId, userId);
    return c.json({ ok: true });
});

// ── Integration update ────────────────────────────────────────────────────────

calendarRoutes.patch('/integrations/:id', authenticateRequest, async (c) => {
    const userId = c.get('session').user.id;
    const integrationId = c.req.param('id');

    const body = await c.req.json<{ calendarId?: unknown }>();
    if (typeof body.calendarId !== 'string' || body.calendarId.trim() === '') {
        return c.json({ error: 'calendarId must be a non-empty string' }, 400);
    }

    const integration = await calendarIntegrationsDAO.findByOwnerAndId(integrationId, userId);
    if (!integration) {
        return c.json({ error: 'Integration not found' }, 404);
    }

    await calendarIntegrationsDAO.updateCalendarId(integrationId, userId, body.calendarId);
    return c.json({ ok: true });
});

// ── Calendar listing ──────────────────────────────────────────────────────────

calendarRoutes.get('/integrations/:id/calendars', authenticateRequest, async (c) => {
    const userId = c.get('session').user.id;
    const integrationId = c.req.param('id');

    const integration = await calendarIntegrationsDAO.findByOwnerAndIdDecrypted(integrationId, userId);
    if (!integration) {
        return c.json({ error: 'Integration not found' }, 404);
    }

    try {
        const provider = buildProvider(integration, userId);
        const calendars = await provider.listCalendars();
        return c.json(calendars);
    } catch (err) {
        console.error(`[calendar] listCalendars failed for integration ${integrationId}:`, err);
        return c.json({ error: 'Failed to fetch calendars from Google' }, 502);
    }
});

// ── Sync config management ───────────────────────────────────────────────────

/** Creates a default CalendarSyncConfig for an integration if none exists yet (lazy migration). */
async function ensureSyncConfigExists(integration: CalendarIntegrationInterface): Promise<void> {
    const existing = await calendarSyncConfigsDAO.findByIntegration(integration._id);
    if (hasAtLeastOne(existing)) {
        return;
    }
    const now = dayjs().toISOString();
    const config: CalendarSyncConfigInterface = {
        _id: randomUUID(),
        integrationId: integration._id,
        user: integration.user,
        calendarId: integration.calendarId,
        isDefault: true,
        enabled: true,
        ...(integration.lastSyncedTs ? { lastSyncedTs: integration.lastSyncedTs } : {}),
        createdTs: now,
        updatedTs: now,
    };
    // Use updateOne+upsert keyed by (integrationId, calendarId) to avoid duplicates
    // if two concurrent requests both see zero configs and try to insert.
    await calendarSyncConfigsDAO.updateOne({ integrationId: integration._id, calendarId: integration.calendarId } as never, { $setOnInsert: config } as never, {
        upsert: true,
    });
}

calendarRoutes.get('/integrations/:id/sync-configs', authenticateRequest, async (c) => {
    const userId = c.get('session').user.id;
    const integrationId = c.req.param('id');

    const integration = await calendarIntegrationsDAO.findByOwnerAndId(integrationId, userId);
    if (!integration) {
        return c.json({ error: 'Integration not found' }, 404);
    }

    const configs = await calendarSyncConfigsDAO.findByIntegration(integrationId);
    return c.json(configs);
});

calendarRoutes.post('/integrations/:id/sync-configs', authenticateRequest, async (c) => {
    const userId = c.get('session').user.id;
    const integrationId = c.req.param('id');

    const integration = await calendarIntegrationsDAO.findByOwnerAndIdDecrypted(integrationId, userId);
    if (!integration) {
        return c.json({ error: 'Integration not found' }, 404);
    }

    const body = await c.req.json<{ calendarId?: unknown; displayName?: unknown; isDefault?: unknown }>();
    if (typeof body.calendarId !== 'string' || body.calendarId.trim() === '') {
        return c.json({ error: 'calendarId must be a non-empty string' }, 400);
    }

    const now = dayjs().toISOString();
    const configId = randomUUID();
    const isDefault = body.isDefault === true;

    const config: CalendarSyncConfigInterface = {
        _id: configId,
        integrationId,
        user: userId,
        calendarId: body.calendarId,
        ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
        isDefault,
        enabled: true,
        createdTs: now,
        updatedTs: now,
    };

    try {
        await calendarSyncConfigsDAO.insertOne(config);
    } catch (err: unknown) {
        if (err instanceof Error && 'code' in err && (err as { code: number }).code === 11000) {
            return c.json({ error: 'This calendar is already being synced' }, 409);
        }
        throw err;
    }

    if (isDefault) {
        await calendarSyncConfigsDAO.setDefault(configId, integrationId);
    }

    // Start receiving push notifications for this calendar (best-effort — sync still works without it).
    const provider = buildProvider(integration, userId);
    await setupWatch(config, provider).catch((err) => {
        console.error(`[calendar] setupWatch failed for config ${configId}:`, err);
    });

    return c.json(config, 201);
});

calendarRoutes.patch('/integrations/:integrationId/sync-configs/:configId', authenticateRequest, async (c) => {
    const userId = c.get('session').user.id;
    const integrationId = c.req.param('integrationId');
    const configId = c.req.param('configId');

    const integration = await calendarIntegrationsDAO.findByOwnerAndIdDecrypted(integrationId, userId);
    if (!integration) {
        return c.json({ error: 'Integration not found' }, 404);
    }

    const config = await calendarSyncConfigsDAO.findByOwnerAndId(configId, userId);
    if (!config || config.integrationId !== integrationId) {
        return c.json({ error: 'Sync config not found' }, 404);
    }

    const body = await c.req.json<{ enabled?: unknown; isDefault?: unknown; displayName?: unknown }>();
    const updates: Partial<CalendarSyncConfigInterface> = { updatedTs: dayjs().toISOString() };

    const enablingWatch = typeof body.enabled === 'boolean' && body.enabled && !config.enabled;
    const disablingWatch = typeof body.enabled === 'boolean' && !body.enabled && config.enabled;

    if (typeof body.enabled === 'boolean') {
        updates.enabled = body.enabled;
    }
    if (typeof body.displayName === 'string') {
        updates.displayName = body.displayName;
    }

    await calendarSyncConfigsDAO.updateOne({ _id: configId, user: userId } as never, { $set: updates });

    if (body.isDefault === true) {
        await calendarSyncConfigsDAO.setDefault(configId, integrationId);
    }

    // Manage webhook channel lifecycle when enabled state changes.
    const provider = buildProvider(integration, userId);
    if (enablingWatch) {
        await setupWatch(config, provider).catch((err) => {
            console.error(`[calendar] setupWatch failed for config ${configId}:`, err);
        });
    } else if (disablingWatch) {
        await teardownWatch(config, provider).catch((err) => {
            console.error(`[calendar] teardownWatch failed for config ${configId}:`, err);
        });
    }

    const updated = await calendarSyncConfigsDAO.findByOwnerAndId(configId, userId);
    return c.json(updated);
});

calendarRoutes.delete('/integrations/:integrationId/sync-configs/:configId', authenticateRequest, async (c) => {
    const userId = c.get('session').user.id;
    const integrationId = c.req.param('integrationId');
    const configId = c.req.param('configId');

    const integration = await calendarIntegrationsDAO.findByOwnerAndIdDecrypted(integrationId, userId);
    if (!integration) {
        return c.json({ error: 'Integration not found' }, 404);
    }

    const config = await calendarSyncConfigsDAO.findByOwnerAndId(configId, userId);
    if (!config || config.integrationId !== integrationId) {
        return c.json({ error: 'Sync config not found' }, 404);
    }

    const now = dayjs().toISOString();

    // Stop the webhook channel before deleting the config so Google stops sending notifications.
    const provider = buildProvider(integration, userId);
    await teardownWatch(config, provider).catch((err) => {
        console.error(`[calendar] teardownWatch failed for config ${configId}:`, err);
    });

    // Clear calendarSyncConfigId from items and routines that reference this config
    // so they don't hold orphaned foreign keys after the config is deleted.
    await clearSyncConfigReferences(userId, configId, now);

    await calendarSyncConfigsDAO.deleteByOwner(configId, userId);
    return c.json({ ok: true });
});

/** Clears `calendarSyncConfigId` from items and routines referencing the given config, and records operations. */
async function clearSyncConfigReferences(userId: string, configId: string, now: string): Promise<void> {
    // Collect IDs before the update — the filter references calendarSyncConfigId which the write clears.
    const [itemsBefore, routinesBefore] = await Promise.all([
        itemsDAO.findArray({ user: userId, calendarSyncConfigId: configId }),
        routinesDAO.findArray({ user: userId, calendarSyncConfigId: configId }),
    ]);

    const itemIds = itemsBefore.map((item) => item._id).filter((id): id is string => Boolean(id));
    const routineIds = routinesBefore.map((r) => r._id);

    await Promise.all([
        itemsDAO.updateMany({ user: userId, calendarSyncConfigId: configId }, { $unset: { calendarSyncConfigId: '' }, $set: { updatedTs: now } }),
        routinesDAO.updateMany({ user: userId, calendarSyncConfigId: configId }, { $unset: { calendarSyncConfigId: '' }, $set: { updatedTs: now } }),
    ]);

    // Re-fetch by stable IDs so operation snapshots reflect the persisted post-write state.
    const [updatedItems, updatedRoutines] = await Promise.all([
        hasAtLeastOne(itemIds) ? itemsDAO.findArray({ _id: { $in: itemIds }, user: userId }) : Promise.resolve([]),
        hasAtLeastOne(routineIds) ? routinesDAO.findArray({ _id: { $in: routineIds }, user: userId }) : Promise.resolve([]),
    ]);

    const itemOps = updatedItems.flatMap((item) => {
        const itemId = item._id;
        if (!itemId) {
            return [];
        }
        return [recordOperation(userId, { entityType: 'item' as const, entityId: itemId, snapshot: item, opType: 'update', now })];
    });
    const routineOps = updatedRoutines.map((r) =>
        recordOperation(userId, { entityType: 'routine' as const, entityId: r._id, snapshot: r, opType: 'update', now }),
    );
    await Promise.all([...itemOps, ...routineOps]);
}

// ── Routine linking ───────────────────────────────────────────────────────────

type CreateEventResult = { ok: true; calendarEventId: string } | { ok: false; error: unknown };

async function tryCreateRecurringEvent(
    provider: GoogleCalendarProvider,
    routine: RoutineInterface,
    calendarId: string,
    timeZone: string,
): Promise<CreateEventResult> {
    try {
        const calendarEventId = await provider.createRecurringEvent(routine, calendarId, timeZone);
        return { ok: true, calendarEventId };
    } catch (error) {
        return { ok: false, error };
    }
}

calendarRoutes.post('/integrations/:id/link-routine/:routineId', authenticateRequest, async (c) => {
    const userId = c.get('session').user.id;
    const integrationId = c.req.param('id');
    const routineId = c.req.param('routineId');

    const [integration, routine] = await Promise.all([
        calendarIntegrationsDAO.findByOwnerAndIdDecrypted(integrationId, userId),
        routinesDAO.findByOwnerAndId(routineId, userId),
    ]);

    if (!integration) {
        return c.json({ error: 'Integration not found' }, 404);
    }
    if (!routine) {
        return c.json({ error: 'Routine not found' }, 404);
    }
    if (routine.routineType !== 'calendar') {
        return c.json({ error: 'Only calendar routines can be linked' }, 400);
    }

    const provider = buildProvider(integration, userId);
    const timeZone = await resolveTimeZoneForIntegration(integrationId, provider, integration.calendarId);
    const createResult = await tryCreateRecurringEvent(provider, routine, integration.calendarId, timeZone);
    if (!createResult.ok) {
        console.error(`[calendar] createRecurringEvent failed for integration ${integrationId}:`, createResult.error);
        return c.json({ error: 'Failed to create Google Calendar event' }, 502);
    }
    const { calendarEventId } = createResult;

    const now = dayjs().toISOString();
    // Seed lastSyncedNotes with the exact HTML we just pushed so the next sync doesn't mistake
    // our own description for an inbound change and doesn't synthesize spurious instance exceptions
    // (buildModifiedException compares each instance description against this baseline).
    const pushedDescription = routine.template.notes !== undefined ? markdownToHtml(routine.template.notes) : undefined;
    const updatedRoutine: RoutineInterface = {
        ...routine,
        calendarEventId,
        calendarIntegrationId: integrationId,
        ...(pushedDescription !== undefined ? { lastSyncedNotes: pushedDescription } : {}),
        updatedTs: now,
    };
    await routinesDAO.replaceById(routineId, updatedRoutine);

    // Record as an operation so other devices sync the calendarEventId update.
    await recordOperation(userId, { entityType: 'routine', entityId: routineId, snapshot: updatedRoutine, opType: 'update', now });

    return c.json({ calendarEventId }, 201);
});

// ── Sync (pull GCal exceptions → app) ────────────────────────────────────────

calendarRoutes.post('/integrations/:id/sync', authenticateRequest, async (c) => {
    const userId = c.get('session').user.id;
    const integrationId = c.req.param('id');

    const integration = await calendarIntegrationsDAO.findByOwnerAndIdDecrypted(integrationId, userId);
    if (!integration) {
        return c.json({ error: 'Integration not found' }, 404);
    }

    try {
        const provider = buildProvider(integration, userId);
        const configs = await calendarSyncConfigsDAO.findEnabledByIntegration(integrationId);
        const now = dayjs().toISOString();

        // Sync each enabled calendar independently — each has its own lastSyncedTs cursor.
        // Sequential to avoid overwhelming Google's API with parallel requests per-account.
        const syncResults = await configs.reduce(async (prevPromise, config) => {
            const prev = await prevPromise;
            const count = await syncSingleCalendar(config, integration, provider, { userId, now, ops: [] });
            // Keep webhook channel alive — renew if expired or expiring soon.
            await renewWebhookIfExpired(config, provider).catch((err) => {
                console.error(`[calendar] renewWebhookIfExpired failed for config ${config._id}:`, err);
            });
            return prev + count;
        }, Promise.resolve(0));

        return c.json({ ok: true, syncedRoutines: syncResults, syncedCalendars: configs.length });
    } catch (err) {
        console.error(`[calendar] sync failed for integration ${integrationId}:`, err);
        return c.json({ error: 'Failed to sync with Google Calendar' }, 502);
    }
});

/** Syncs a single calendar config: routine exceptions + event import. Returns the number of routines synced. */
async function syncSingleCalendar(
    config: CalendarSyncConfigInterface,
    integration: CalendarIntegrationInterface,
    provider: GoogleCalendarProvider,
    ctx: SyncContext,
): Promise<number> {
    // Refresh the cached timezone on every sync so changes in Google Calendar are picked up.
    await refreshTimeZone(config, provider);

    const since = config.lastSyncedTs ?? dayjs(0).toISOString();
    const linkedRoutines = await routinesDAO.findArray({
        user: ctx.userId,
        calendarIntegrationId: integration._id,
        calendarEventId: { $exists: true },
        // Inactive routines no longer generate items — skip exception sync to avoid redundant
        // DB writes and prevent overwriting the deactivation state on repeated syncs.
        active: { $ne: false },
        // Include routines explicitly linked to this config, plus legacy routines without a config link.
        $or: [{ calendarSyncConfigId: config._id }, { calendarSyncConfigId: { $exists: false } }],
    });

    const syncCtx: RoutineSyncCtx = { userId: ctx.userId, since, now: ctx.now, calendarId: config.calendarId, ops: ctx.ops };
    await Promise.all(linkedRoutines.map((routine) => syncRoutineExceptions(routine, provider, syncCtx)));

    const source: CalendarSource = { integration, config };
    const syncResult = await fetchEventsWithSyncToken(config, provider, ctx.now);
    await importCalendarEvents(source, syncResult.events, ctx);
    await calendarSyncConfigsDAO.upsertSyncToken(config._id, syncResult.nextSyncToken, ctx.now);

    return linkedRoutines.length;
}

/**
 * Fetches events using the syncToken if available, falling back to a full sync.
 * On 410 Gone (token expired), clears the token and retries as a full sync.
 */
async function fetchEventsWithSyncToken(config: CalendarSyncConfigInterface, provider: GoogleCalendarProvider, now: string): Promise<EventSyncResult> {
    if (config.syncToken) {
        try {
            return await provider.listEventsIncremental(config.calendarId, config.syncToken);
        } catch (err) {
            if (err instanceof SyncTokenInvalidError) {
                console.warn(`[calendar] syncToken expired for config ${config._id}, falling back to full sync`);
                await calendarSyncConfigsDAO.upsertSyncToken(config._id, '', config.lastSyncedTs ?? dayjs(0).toISOString());
                return provider.listEventsFull(config.calendarId, now);
            }
            throw err;
        }
    }
    return provider.listEventsFull(config.calendarId, now);
}

// ── Calendar event import ─────────────────────────────────────────────────────

/**
 * Imports pre-fetched Google Calendar events as `calendar` items or routines.
 * - Recurring master events (with `recurrence`) are imported as routines.
 * - Events whose id matches an existing routine's calendarEventId are also routed to the
 *   routine path — cancelled master events from incremental sync often lack the `recurrence`
 *   field, but still need to deactivate the corresponding routine.
 * - Instances whose recurringEventId belongs to a linked routine are skipped (managed by exception sync).
 * - All other events are upserted as individual calendar items.
 */
async function importCalendarEvents(source: CalendarSource, events: GCalEvent[], ctx: SyncContext): Promise<void> {
    // Fetch existing linked routines so we can also route events that match a known routine
    // calendarEventId — handles cancelled masters that arrive without a `recurrence` field.
    const existingLinkedRoutines = await routinesDAO.findArray({
        user: ctx.userId,
        calendarIntegrationId: source.integration._id,
        calendarEventId: { $exists: true },
    });
    const knownRoutineEventIds = new Set(existingLinkedRoutines.map((r) => r.calendarEventId).filter((id): id is string => Boolean(id)));

    const isRecurringMaster = (e: GCalEvent) => hasAtLeastOne(e.recurrence ?? []) || knownRoutineEventIds.has(e.id);
    const recurringMasters = events.filter(isRecurringMaster);
    const regularEvents = events.filter((e) => !isRecurringMaster(e));

    // Import recurring masters as routines first — their calendarEventIds must be known
    // before filtering regular events so instances of these series are correctly skipped.
    await Promise.all(recurringMasters.map((event) => importRecurringEventAsRoutine(event, source, ctx)));

    // Re-fetch after importing new recurring masters so freshly created routines are included.
    const allLinkedRoutines = await routinesDAO.findArray({
        user: ctx.userId,
        calendarIntegrationId: source.integration._id,
        calendarEventId: { $exists: true },
    });
    const routineEventIds = new Set(allLinkedRoutines.map((r) => r.calendarEventId).filter((id): id is string => Boolean(id)));

    // Detect GCal series splits ("this and all following") and link new routines to their parent.
    await detectAndLinkSplits(existingLinkedRoutines, allLinkedRoutines, recurringMasters, ctx);

    const eventsToUpsert = regularEvents.filter((e) => !e.recurringEventId || !routineEventIds.has(e.recurringEventId));
    await Promise.all(eventsToUpsert.map((event) => upsertCalendarItem(event, source, ctx)));
}

/**
 * Detect GCal series splits: when "this and all following" is used in GCal, the original series
 * gains UNTIL and a new master is created. Link the new routine to the original via splitFromRoutineId
 * using a timing overlap heuristic (new series starts within 0–2 days after original's UNTIL).
 */
async function detectAndLinkSplits(
    routinesBeforeImport: RoutineInterface[],
    routinesAfterImport: RoutineInterface[],
    masterEvents: GCalEvent[],
    ctx: SyncContext,
): Promise<void> {
    const existingIds = new Set(routinesBeforeImport.map((r) => r._id));
    const newRoutines = routinesAfterImport.filter((r) => !existingIds.has(r._id));
    if (!hasAtLeastOne(newRoutines)) {
        return;
    }

    // Existing routines that now have UNTIL are potential split parents
    const parentCandidates = routinesAfterImport.filter((r) => existingIds.has(r._id) && r.rrule.includes('UNTIL='));

    for (const tail of newRoutines) {
        if (tail.splitFromRoutineId) {
            continue;
        }

        // Use the GCal event's start time as the tail's first occurrence
        const event = masterEvents.find((e) => e.id === tail.calendarEventId);
        if (!event) {
            continue;
        }

        const tailStart = dayjs(event.timeStart).startOf('day');

        const parent = parentCandidates.find((candidate) => {
            if (candidate.calendarSyncConfigId !== tail.calendarSyncConfigId) {
                return false;
            }
            const untilDate = extractUntilFromRrule(candidate.rrule);
            if (!untilDate) {
                return false;
            }
            const untilDay = dayjs(untilDate).startOf('day');
            const gapDays = tailStart.diff(untilDay, 'day');
            return gapDays >= 0 && gapDays <= 2;
        });

        if (parent) {
            const linked: RoutineInterface = { ...tail, splitFromRoutineId: parent._id, updatedTs: ctx.now };
            await routinesDAO.replaceById(tail._id, linked);
            ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'routine', entityId: tail._id, snapshot: linked, opType: 'update', now: ctx.now }));
        }
    }
}

// ── Recurring event → routine import ─────────────────────────────────────────

/** Extracts HH:mm in the calendar's IANA timezone from an ISO datetime string.
 *  calendarItemTemplate.timeOfDay stores local time matching the calendar timezone,
 *  so it round-trips correctly through buildDateTime (which re-applies the timezone). */
export function extractLocalTime(isoDatetime: string, timeZone: string): string {
    return dayjs(isoDatetime).tz(timeZone).format('HH:mm');
}

/** Extracts the RRULE string from a GCal recurrence array, stripping the "RRULE:" prefix. */
function extractRrule(recurrence: string[]): string | null {
    const rruleLine = recurrence.find((r) => r.startsWith('RRULE:'));
    return rruleLine ? rruleLine.replace(/^RRULE:/, '') : null;
}

/**
 * Imports a GCal recurring master event as a routine.
 * Creates a new routine if none exists for this calendarEventId, or updates the existing one.
 */
async function importRecurringEventAsRoutine(event: GCalEvent, source: CalendarSource, ctx: SyncContext): Promise<void> {
    const [existing] = await routinesDAO.findArray({
        user: ctx.userId,
        calendarEventId: event.id,
        calendarIntegrationId: source.integration._id,
    });

    if (existing?.lastPushedToGCalTs && isOwnEcho(existing.lastPushedToGCalTs, event.updated)) {
        return;
    }

    if (event.status === 'cancelled') {
        console.log(`[gcal-sync] deactivating routine | eventId=${event.id} title=${event.title}`);
        await deactivateRoutineFromGCal(existing, ctx);
        return;
    }

    const rrule = extractRrule(event.recurrence ?? []);
    if (!rrule) {
        console.warn(`[calendar] recurring master event ${event.id} has no RRULE in recurrence — skipping routine import`);
        return;
    }

    if (existing) {
        console.log(`[gcal-sync] updating routine | eventId=${event.id} title=${event.title} routineId=${existing._id}`);
        await updateRoutineFromGCal(existing, event, rrule, source, ctx);
        return;
    }

    console.log(`[gcal-sync] creating routine | eventId=${event.id} title=${event.title} rrule=${rrule}`);
    await createRoutineFromGCal(event, rrule, source, ctx);
}

async function createRoutineFromGCal(event: GCalEvent, rrule: string, source: CalendarSource, ctx: SyncContext): Promise<void> {
    const timeOfDay = extractLocalTime(event.timeStart, source.config.timeZone ?? 'UTC');
    const duration = dayjs(event.timeEnd).diff(dayjs(event.timeStart), 'minute');

    // Use the GCal event's start date as createdTs so the rrule DTSTART is anchored
    // to the first occurrence. This is critical for split tails ("this and following"):
    // the new master's start is the split date, not the sync time.
    const createdTs = dayjs(event.timeStart).toISOString();

    const routineId = randomUUID();
    const routine: RoutineInterface = {
        _id: routineId,
        user: ctx.userId,
        title: event.title,
        routineType: 'calendar',
        rrule,
        active: true,
        calendarEventId: event.id,
        calendarIntegrationId: source.integration._id,
        calendarSyncConfigId: source.config._id,
        calendarItemTemplate: { timeOfDay, duration },
        template: event.description != null ? { notes: htmlToMarkdown(event.description) } : {},
        ...(event.description != null ? { lastSyncedNotes: event.description } : {}),
        createdTs,
        updatedTs: ctx.now,
    };

    await routinesDAO.insertOne(routine);
    ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'routine', entityId: routineId, snapshot: routine, opType: 'create', now: ctx.now }));
}

async function updateRoutineFromGCal(existing: RoutineInterface, event: GCalEvent, rrule: string, source: CalendarSource, ctx: SyncContext): Promise<void> {
    const routineId = existing._id;

    // Determine notes update independently of structural fields.
    // For routines, GCal description maps to template.notes (not a top-level notes field).
    const notesUpdate = resolveInboundNotes(event.description, existing.lastSyncedNotes, event.updated, existing.updatedTs);

    const structurallyNewer = isGCalAtLeastAsRecent(event.updated, existing.updatedTs);
    if (!structurallyNewer && !notesUpdate) {
        return;
    }

    const timeOfDay = extractLocalTime(event.timeStart, source.config.timeZone ?? 'UTC');
    const duration = dayjs(event.timeEnd).diff(dayjs(event.timeStart), 'minute');

    // Re-fetch: routineExceptions may have been written by syncRoutineExceptions earlier in the same
    // sync cycle, and the `existing` snapshot we were passed predates that write. Using the stale
    // snapshot as the base for replaceById would drop those exceptions.
    const fresh = (await routinesDAO.findByOwnerAndId(routineId, ctx.userId)) ?? existing;

    const updated: RoutineInterface = {
        ...fresh,
        ...(structurallyNewer
            ? {
                  title: event.title,
                  rrule,
                  calendarSyncConfigId: source.config._id,
                  calendarItemTemplate: { timeOfDay, duration },
              }
            : {}),
        ...(notesUpdate
            ? {
                  // Falsy (empty string) means GCal cleared the description — remove template.notes entirely.
                  template: notesUpdate.notes ? { ...fresh.template, notes: notesUpdate.notes } : omitNotes(fresh.template),
                  lastSyncedNotes: notesUpdate.lastSyncedNotes,
              }
            : {}),
        updatedTs: ctx.now,
    };

    await routinesDAO.replaceById(routineId, updated);
    ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'routine', entityId: routineId, snapshot: updated, opType: 'update', now: ctx.now }));

    // When GCal adds UNTIL (series split via "this and all following"), trash items past the UNTIL date.
    if (structurallyNewer && !existing.rrule.includes('UNTIL=') && rrule.includes('UNTIL=')) {
        const untilDate = extractUntilFromRrule(rrule);
        if (untilDate) {
            await updateItemsAndRecordOps(ctx, {
                filter: { user: ctx.userId, routineId, status: 'calendar', timeStart: { $gt: untilDate } },
                setFields: { status: 'trash', updatedTs: ctx.now },
            });
        }
    }

    // Propagate notes change to all future calendar items belonging to this routine.
    if (notesUpdate) {
        const itemOps = await propagateRoutineNotesToItems(routineId, notesUpdate.notes || undefined, ctx.userId, ctx.now);
        ctx.ops.push(...itemOps);
    }
}

async function deactivateRoutineFromGCal(existing: RoutineInterface | undefined, ctx: SyncContext): Promise<void> {
    if (!existing || !existing.active) {
        return;
    }

    const routineId = existing._id;
    // Re-fetch to pick up any writes from the exception sync that ran earlier in the same cycle.
    const fresh = await routinesDAO.findByOwnerAndId(routineId, ctx.userId);
    const updated: RoutineInterface = { ...(fresh ?? existing), active: false, updatedTs: ctx.now };
    await routinesDAO.replaceById(routineId, updated);
    ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'routine', entityId: routineId, snapshot: updated, opType: 'update', now: ctx.now }));

    // Trash all future items belonging to this routine.
    await updateItemsAndRecordOps(ctx, {
        filter: { user: ctx.userId, routineId, status: 'calendar', timeStart: { $gte: ctx.now } },
        setFields: { status: 'trash', updatedTs: ctx.now },
    });
}

// ── Notes/description conflict resolution ───────────────────────────────────

/** Returns a copy of the template without the `notes` property (satisfies exactOptionalPropertyTypes). */
function omitNotes(template: RoutineItemTemplate): RoutineItemTemplate {
    const { notes: _, ...rest } = template;
    return rest;
}

/**
 * GCal's `event.updated` is truncated to seconds while local `updatedTs` carries milliseconds.
 * String comparison would drop legitimate GCal edits that land within the same wall-clock second
 * as a local write (e.g. a user editing in GCal right after link-routine wrote locally). Compare
 * at second precision with `>=` so that within the same second, GCal wins.
 */
function isGCalAtLeastAsRecent(gcalUpdated: string, localUpdatedTs: string): boolean {
    return dayjs(gcalUpdated).unix() >= dayjs(localUpdatedTs).unix();
}

/**
 * Determines whether inbound GCal description should overwrite local notes.
 * Returns `{ notes (markdown), lastSyncedNotes (raw HTML) }` when GCal wins,
 * or `null` when local notes stay.
 *
 * `lastSyncedNotes` stores raw GCal HTML (not Markdown) so the change-detection
 * comparison is always apples-to-apples: HTML in vs. HTML stored.
 */
export function resolveInboundNotes(
    gcalDescription: string | undefined,
    lastSyncedNotes: string | undefined,
    gcalUpdated: string,
    localUpdatedTs: string,
): { notes: string; lastSyncedNotes: string } | null {
    // Normalize: treat undefined as empty string for comparison purposes,
    // so that a deleted GCal description (undefined) is detected as a change
    // when we previously synced a non-empty value.
    const effectiveDescription = gcalDescription ?? '';
    const effectiveSynced = lastSyncedNotes ?? '';

    if (effectiveDescription === effectiveSynced) {
        return null; // No change — keep local notes untouched.
    }
    // GCal changed its description. Last-write-wins on timestamp, with same-second going to GCal
    // (see isGCalAtLeastAsRecent for the rationale).
    if (isGCalAtLeastAsRecent(gcalUpdated, localUpdatedTs)) {
        return {
            notes: effectiveDescription ? htmlToMarkdown(effectiveDescription) : '',
            lastSyncedNotes: effectiveDescription,
        };
    }
    // Local is newer — keep local notes. Next outbound push will correct GCal.
    return null;
}

// ── Single calendar event import ─────────────────────────────────────────────

type CalendarEvent = { id: string; title: string; timeStart: string; timeEnd: string; updated: string; status: string; description?: string };

async function upsertCalendarItem(event: CalendarEvent, source: CalendarSource, ctx: SyncContext): Promise<void> {
    const [existing] = await itemsDAO.findArray({ user: ctx.userId, calendarEventId: event.id });

    // Echo detection: if the item was recently pushed to GCal by the app, skip re-importing
    // the same change back. The 5-second window catches the typical push→webhook roundtrip.
    if (existing?.lastPushedToGCalTs && isOwnEcho(existing.lastPushedToGCalTs, event.updated)) {
        return;
    }

    if (event.status === 'cancelled') {
        await trashCancelledItem(existing, ctx);
        return;
    }

    // Past events from Google are only relevant if they already exist locally — update them
    // to reflect any changes (e.g. title/time edits). New past events are ignored.
    if (event.timeStart && isPastEvent(event, ctx.now)) {
        if (existing) {
            await updateExistingCalendarItem(existing, event, source, ctx);
        }
        return;
    }

    if (existing) {
        await updateExistingCalendarItem(existing, event, source, ctx);
    } else {
        await createNewCalendarItem(event, source, ctx);
    }
}

async function trashCancelledItem(existing: ItemInterface | undefined, ctx: SyncContext): Promise<void> {
    if (!existing || existing.routineId) {
        return;
    }
    const itemId = existing._id;
    if (!itemId) {
        return;
    }
    await itemsDAO.updateOne({ _id: itemId, user: ctx.userId }, { $set: { status: 'trash', updatedTs: ctx.now } });
    const op = await recordOperation(ctx.userId, {
        entityType: 'item',
        entityId: itemId,
        snapshot: { ...existing, status: 'trash', updatedTs: ctx.now },
        opType: 'update',
        now: ctx.now,
    });
    ctx.ops.push(op);
}

async function updateExistingCalendarItem(existing: ItemInterface, event: CalendarEvent, source: CalendarSource, ctx: SyncContext): Promise<void> {
    if (existing.routineId) {
        return; // routine-managed; skip
    }
    const itemId = existing._id;
    if (!itemId) {
        return;
    }

    // Determine notes update independently of structural fields (title/time).
    const notesUpdate = resolveInboundNotes(event.description, existing.lastSyncedNotes, event.updated, existing.updatedTs);

    // Structural fields still use the simple timestamp guard.
    const structurallyNewer = event.updated > existing.updatedTs;
    if (!structurallyNewer && !notesUpdate) {
        return;
    }

    const updated: ItemInterface = {
        ...existing,
        ...(structurallyNewer
            ? {
                  title: event.title,
                  timeStart: event.timeStart,
                  timeEnd: event.timeEnd,
                  calendarSyncConfigId: source.config._id,
              }
            : {}),
        ...notesUpdate,
        updatedTs: ctx.now,
    };
    await itemsDAO.replaceById(itemId, updated);
    ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'item', entityId: itemId, snapshot: updated, opType: 'update', now: ctx.now }));
}

async function createNewCalendarItem(event: CalendarEvent, source: CalendarSource, ctx: SyncContext): Promise<void> {
    const itemId = randomUUID();
    const newItem: ItemInterface = {
        _id: itemId,
        user: ctx.userId,
        status: 'calendar',
        title: event.title,
        timeStart: event.timeStart,
        timeEnd: event.timeEnd,
        calendarEventId: event.id,
        calendarIntegrationId: source.integration._id,
        calendarSyncConfigId: source.config._id,
        ...(event.description != null ? { notes: htmlToMarkdown(event.description), lastSyncedNotes: event.description } : {}),
        createdTs: ctx.now,
        updatedTs: ctx.now,
    };
    await itemsDAO.insertOne(newItem);
    ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'item', entityId: itemId, snapshot: newItem, opType: 'create', now: ctx.now }));
}

type RoutineException = NonNullable<RoutineInterface['routineExceptions']>[number];

/** Builds a single exception entry from a GCal exception. */
function buildExceptionEntry(ex: GCalException): RoutineException {
    if (ex.type === 'deleted') {
        return { date: ex.originalDate, type: 'skipped' };
    }
    return {
        date: ex.originalDate,
        type: 'modified',
        ...(ex.newTimeStart ? { newTimeStart: ex.newTimeStart } : {}),
        ...(ex.newTimeEnd ? { newTimeEnd: ex.newTimeEnd } : {}),
        ...(ex.title !== undefined ? { title: ex.title } : {}),
        // ex.notes is raw HTML from GCal — convert to markdown for client consumption
        ...(ex.notes !== undefined ? { notes: htmlToMarkdown(ex.notes) } : {}),
    };
}

/** Merges an incoming GCal exception into the routine's existing exception list (immutably). */
function mergeExceptions(existing: RoutineException[], ex: GCalException): RoutineException[] {
    const entry = buildExceptionEntry(ex);
    const idx = existing.findIndex((e) => e.date === ex.originalDate);
    if (idx >= 0) {
        return existing.map((e, i) => (i === idx ? entry : e));
    }
    return [...existing, entry];
}

/**
 * Applies a MongoDB $set to items matching `filter`, then records an operation for each
 * affected item.
 *
 * IDs are collected BEFORE the update because `filter` may reference fields that `setFields`
 * changes (e.g. `modified` exceptions change `timeStart` — re-querying with the original
 * timeStart filter after the write would return zero results).  The post-write re-fetch by
 * stable ID ensures operation snapshots reflect the persisted state.
 */
async function updateItemsAndRecordOps(ctx: SyncContext, query: { filter: Record<string, unknown>; setFields: Record<string, unknown> }): Promise<void> {
    const before = await itemsDAO.findArray(query.filter);
    const ids = before.map((item) => item._id).filter((id): id is string => Boolean(id));
    if (!hasAtLeastOne(ids)) {
        return;
    }
    await itemsDAO.updateMany(query.filter, { $set: query.setFields });
    // Re-fetch by stable ID so the snapshot reflects the post-write state.
    const updated = await itemsDAO.findArray({ _id: { $in: ids }, user: ctx.userId });
    const ops = await Promise.all(
        updated.flatMap((item) => {
            const itemId = item._id;
            if (!itemId) {
                return [];
            }
            return [recordOperation(ctx.userId, { entityType: 'item', entityId: itemId, snapshot: item, opType: 'update', now: ctx.now })];
        }),
    );
    ctx.ops.push(...ops);
}

/** Applies a single GCal exception's side effects to the items collection. */
async function applyExceptionToItems(routine: RoutineInterface, ex: GCalException, ctx: SyncContext): Promise<void> {
    if (!ISO_DATE_RE.test(ex.originalDate)) {
        return;
    }
    // Use a date-range query rather than $regex to avoid regex injection from GCal data.
    const nextDay = dayjs(ex.originalDate).add(1, 'day').format('YYYY-MM-DD');
    const dateFilter = { $gte: ex.originalDate, $lt: nextDay };
    const baseFilter = { user: ctx.userId, routineId: routine._id, timeStart: dateFilter };

    if (ex.type === 'deleted') {
        await updateItemsAndRecordOps(ctx, { filter: baseFilter, setFields: { status: 'trash', updatedTs: ctx.now } });
        return;
    }

    if (ex.type === 'modified') {
        const setFields = {
            updatedTs: ctx.now,
            ...(ex.newTimeStart ? { timeStart: ex.newTimeStart } : {}),
            ...(ex.newTimeEnd ? { timeEnd: ex.newTimeEnd } : {}),
            ...(ex.title !== undefined ? { title: ex.title } : {}),
            // ex.notes is raw HTML from GCal — convert to markdown for storage, keep HTML as lastSyncedNotes
            ...(ex.notes !== undefined ? { notes: htmlToMarkdown(ex.notes), lastSyncedNotes: ex.notes } : {}),
        };
        await updateItemsAndRecordOps(ctx, { filter: baseFilter, setFields });
    }
}

async function syncRoutineExceptions(routine: RoutineInterface, provider: GoogleCalendarProvider, ctx: RoutineSyncCtx): Promise<void> {
    if (!routine.calendarEventId) {
        return;
    }

    // Compare against lastSyncedNotes (raw HTML) since GCal returns HTML descriptions.
    const masterContent = { title: routine.title, description: routine.lastSyncedNotes ?? '' };
    const exceptions = await provider.getExceptions(routine.calendarEventId, ctx.calendarId, ctx.since, masterContent);
    if (!hasAtLeastOne(exceptions)) {
        return;
    }

    console.log(`[gcal-sync] syncing routine exceptions | routineId=${routine._id} title=${routine.title} exceptionCount=${exceptions.length}`);

    const updatedExceptions = exceptions.reduce((acc, ex) => mergeExceptions(acc, ex), [...(routine.routineExceptions ?? [])]);
    // Apply item side-effects in parallel — each exception targets a different date so there
    // are no write conflicts between them.
    const syncCtx: SyncContext = { userId: ctx.userId, now: ctx.now, ops: ctx.ops };
    await Promise.all(exceptions.map((ex) => applyExceptionToItems(routine, ex, syncCtx)));

    // Preserve `updatedTs`: exception writes are sync bookkeeping, not user/app edits. Bumping
    // `updatedTs` here would corrupt the `structurallyNewer` comparison in `updateRoutineFromGCal`
    // later in the same sync cycle (it would falsely look like local is newer than GCal). Clients
    // still learn about the change via the operation log, which is keyed on op.ts (= ctx.now).
    const updatedRoutine: RoutineInterface = { ...routine, routineExceptions: updatedExceptions };
    await routinesDAO.replaceById(routine._id, updatedRoutine);

    ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'routine', entityId: routine._id, snapshot: updatedRoutine, opType: 'update', now: ctx.now }));
}

// ── Webhook watch management ─────────────────────────────────────────────────

/** Sets up a Google push notification channel for the given sync config. Stores webhook fields on success. */
async function setupWatch(config: CalendarSyncConfigInterface, provider: GoogleCalendarProvider): Promise<void> {
    // Webhook feature is opt-in: no-op when CALENDAR_WEBHOOK_URL is not configured.
    const webhookUrl = process.env.CALENDAR_WEBHOOK_URL;
    if (!webhookUrl) {
        return;
    }
    const channelId = randomUUID();
    const { resourceId, expiration } = await provider.watchEvents(config.calendarId, webhookUrl, channelId);
    await calendarSyncConfigsDAO.upsertWebhookFields(config._id, channelId, resourceId, expiration);
}

/** Stops the existing push notification channel for the given sync config. Clears webhook fields regardless of whether the stop call succeeds. */
async function teardownWatch(config: CalendarSyncConfigInterface, provider: GoogleCalendarProvider): Promise<void> {
    if (config.webhookChannelId && config.webhookResourceId) {
        // Best-effort stop — the channel may have already expired or been invalidated.
        await provider.stopWatch(config.webhookChannelId, config.webhookResourceId).catch(() => {});
    }
    await calendarSyncConfigsDAO.clearWebhookFields(config._id);
}

/** Re-registers the webhook channel if it is expired or expiring within 1 day. */
async function renewWebhookIfExpired(config: CalendarSyncConfigInterface, provider: GoogleCalendarProvider): Promise<void> {
    if (!process.env.CALENDAR_WEBHOOK_URL) {
        return;
    }

    const needsRenewal = !config.webhookExpiry || dayjs(config.webhookExpiry).isBefore(dayjs().add(1, 'day'));
    if (!needsRenewal) {
        return;
    }

    if (config.webhookChannelId) {
        await teardownWatch(config, provider);
    }
    await setupWatch(config, provider);
    console.log(`[calendar-webhook] renewed watch for config ${config._id}`);
}

export { buildProvider, renewWebhookIfExpired };

// ── Webhook receiver ─────────────────────────────────────────────────────────

// In-memory dedup: Google often fires multiple notifications for the same change in rapid succession.
// Track recently-processed channel IDs to avoid redundant syncs within a short window.
// Uses raw epoch-ms (Date.now) instead of dayjs because this is a hot path comparing
// monotonic timestamps — dayjs object allocation would add unnecessary overhead.
const recentWebhookChannels = new Map<string, number>();
const WEBHOOK_DEDUP_TTL_MS = 10_000;

/** Removes entries older than the TTL to prevent unbounded memory growth. */
function pruneStaleWebhookEntries(now: number): void {
    for (const [key, ts] of recentWebhookChannels) {
        if (now - ts > WEBHOOK_DEDUP_TTL_MS) {
            recentWebhookChannels.delete(key);
        }
    }
}

/** Returns true if this channel was already seen within the dedup window. Records the arrival for future checks. */
function checkAndRecordWebhook(channelId: string): boolean {
    const now = Date.now();
    const lastSeen = recentWebhookChannels.get(channelId);
    const isDuplicate = Boolean(lastSeen && now - lastSeen < WEBHOOK_DEDUP_TTL_MS);
    recentWebhookChannels.set(channelId, now);
    pruneStaleWebhookEntries(now);
    return isDuplicate;
}

// No authenticateRequest — Google sends these webhooks directly.
// Security: verified by looking up the channel ID in our database.
calendarRoutes.post('/webhooks/google', async (c) => {
    const channelId = c.req.header('x-goog-channel-id');
    const resourceId = c.req.header('x-goog-resource-id');
    const resourceState = c.req.header('x-goog-resource-state');

    if (!channelId || !resourceId) {
        return c.text('Missing required headers', 400);
    }

    // Google sends a 'sync' notification when the watch is first established — just acknowledge it.
    if (resourceState === 'sync') {
        return c.text('OK', 200);
    }

    const config = await calendarSyncConfigsDAO.findByWebhookChannelId(channelId);
    if (!config || config.webhookResourceId !== resourceId) {
        return c.text('Unknown channel', 404);
    }

    // Respond immediately — Google expects a fast 200. Sync runs asynchronously.
    const response = c.text('OK', 200);

    console.log(
        `[gcal-webhook] received | channelId=${channelId} resourceId=${resourceId} state=${resourceState} configId=${config._id} calendarId=${config.calendarId}`,
    );

    const isDuplicate = checkAndRecordWebhook(channelId);
    if (isDuplicate) {
        console.log(`[gcal-webhook] duplicate — skipping sync | channelId=${channelId}`);
    } else {
        // Fire-and-forget: run the sync in the background so we don't block the webhook response.
        runWebhookSync(config).catch((err) => {
            console.error(`[calendar-webhook] sync failed for config ${config._id}:`, err);
        });
    }

    return response;
});

/** Runs an incremental sync for a single calendar config, triggered by a webhook notification. */
async function runWebhookSync(config: CalendarSyncConfigInterface): Promise<void> {
    console.log(`[gcal-webhook-sync] starting | configId=${config._id} calendarId=${config.calendarId}`);
    const integration = await calendarIntegrationsDAO.findByOwnerAndIdDecrypted(config.integrationId, config.user);
    if (!integration) {
        console.warn(`[calendar-webhook] integration ${config.integrationId} not found for config ${config._id} — skipping sync`);
        return;
    }
    const provider = buildProvider(integration, config.user);
    const now = dayjs().toISOString();
    const ctx: SyncContext = { userId: config.user, now, ops: [] };
    await syncSingleCalendar(config, integration, provider, ctx);
    console.log(`[gcal-webhook-sync] sync complete | configId=${config._id} ops=${ctx.ops.length}`);
    // Keep webhook channel alive — renew if close to expiring so the next change also triggers a webhook.
    await renewWebhookIfExpired(config, provider).catch((err) => {
        console.error(`[calendar-webhook] renewWebhookIfExpired failed for config ${config._id}:`, err);
    });
    console.log(`[gcal-webhook-sync] notifying SSE + push | userId=${config.user} ops=${ctx.ops.length}`);
    notifyUserViaSse(config.user, { type: 'update', ts: now });
    // Web Push for devices without an open SSE connection (app closed / backgrounded).
    await notifyViaWebPush(config.user, null, ctx.ops, now).catch((err) => {
        console.error(`[calendar-webhook] web push failed for user ${config.user}:`, err);
    });
}

// ── Webhook renewal ──────────────────────────────────────────────────────────

// Secured by a shared secret so only the Cloud Scheduler job can trigger renewal.
calendarRoutes.post('/webhooks/renew', async (c) => {
    const cronSecret = c.req.header('x-webhook-cron-secret');
    if (!cronSecret || cronSecret !== process.env.CALENDAR_WEBHOOK_CRON_SECRET) {
        return c.text('Unauthorized', 401);
    }

    const horizon = dayjs().add(1, 'day').toISOString();
    const expiring = await calendarSyncConfigsDAO.findNeedingWebhook(horizon);

    const results = await Promise.allSettled(
        expiring.map(async (config) => {
            const integration = await calendarIntegrationsDAO.findByOwnerAndIdDecrypted(config.integrationId, config.user);
            if (!integration) {
                return;
            }
            const provider = buildProvider(integration, config.user);
            await renewWebhookIfExpired(config, provider);
        }),
    );

    const failed = results.filter((r) => r.status === 'rejected').length;
    return c.json({ renewed: results.length - failed, failed });
});

export { calendarRoutes };
