import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import dayjs from 'dayjs';
import { google } from 'googleapis';
import { Hono } from 'hono';
import { authenticateRequest } from '../auth/middleware.js';
import type { GCalException } from '../calendarProviders/CalendarProvider.js';
import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import { clientUrl } from '../config.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { hasAtLeastOne } from '../lib/typeUtils.js';
import type { AuthVariables } from '../types/authTypes.js';
import type { CalendarIntegrationInterface, ItemInterface, RoutineInterface } from '../types/entities.js';

type UnlinkAction = 'keepEvents' | 'deleteEvents' | 'deleteAll';
type SyncContext = { userId: string; now: string };
type RoutineSyncCtx = { userId: string; since: string; now: string; calendarId: string };
type UnlinkSideEffectCtx = { provider: GoogleCalendarProvider; calendarId: string; userId: string; now: string };
// Discriminated union to distinguish network failures from missing-token responses in the OAuth flow.
type OAuthTokenResult =
    | { ok: true; accessToken: string; refreshToken: string; expiryDate: number | null | undefined }
    | { ok: false; reason: 'exchange_failed' | 'missing_tokens' };

// ISO date string pattern — used to validate originalDate before building MongoDB queries.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

// ── Integration management ────────────────────────────────────────────────────

calendarRoutes.get('/integrations', authenticateRequest, async (c) => {
    const userId = c.get('session').user.id;
    const integrations = await calendarIntegrationsDAO.findByUserDecrypted(userId);
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
            routinesDAO.updateOne({ _id: r._id, user: userId }, { $unset: { calendarEventId: '', calendarIntegrationId: '' }, $set: { updatedTs: now } }),
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

// ── Routine linking ───────────────────────────────────────────────────────────

type CreateEventResult = { ok: true; calendarEventId: string } | { ok: false; error: unknown };

async function tryCreateRecurringEvent(provider: GoogleCalendarProvider, routine: RoutineInterface, calendarId: string): Promise<CreateEventResult> {
    try {
        const calendarEventId = await provider.createRecurringEvent(routine, calendarId);
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
    const createResult = await tryCreateRecurringEvent(provider, routine, integration.calendarId);
    if (!createResult.ok) {
        console.error(`[calendar] createRecurringEvent failed for integration ${integrationId}:`, createResult.error);
        return c.json({ error: 'Failed to create Google Calendar event' }, 502);
    }
    const { calendarEventId } = createResult;

    const now = dayjs().toISOString();
    const updatedRoutine: RoutineInterface = { ...routine, calendarEventId, calendarIntegrationId: integrationId, updatedTs: now };
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

    // Use epoch start if never synced so the first pull fetches all historical exceptions.
    const since = integration.lastSyncedTs ?? dayjs(0).toISOString();

    try {
        const provider = buildProvider(integration, userId);
        const linkedRoutines = await routinesDAO.findArray({
            user: userId,
            calendarIntegrationId: integrationId,
            calendarEventId: { $exists: true },
        });

        const now = dayjs().toISOString();
        const syncCtx: RoutineSyncCtx = { userId, since, now, calendarId: integration.calendarId };
        await Promise.all(linkedRoutines.map((routine) => syncRoutineExceptions(routine, provider, syncCtx)));
        await importCalendarItems(integration, provider, { userId, now });

        await calendarIntegrationsDAO.bumpLastSyncedTs(integrationId, userId, now);
        return c.json({ ok: true, syncedRoutines: linkedRoutines.length });
    } catch (err) {
        console.error(`[calendar] sync failed for integration ${integrationId}:`, err);
        return c.json({ error: 'Failed to sync with Google Calendar' }, 502);
    }
});

// ── Calendar event import ─────────────────────────────────────────────────────

/**
 * Imports Google Calendar events as `calendar` items.
 * Skips instances whose recurringEventId belongs to a routine already linked to this integration —
 * those are managed by the routine exception sync path.
 */
async function importCalendarItems(integration: CalendarIntegrationInterface, provider: GoogleCalendarProvider, ctx: SyncContext): Promise<void> {
    const since = dayjs(ctx.now).subtract(30, 'day').toISOString();
    const until = dayjs(ctx.now).add(90, 'day').toISOString();

    const [events, linkedRoutines] = await Promise.all([
        provider.listEvents(integration.calendarId, since, until),
        routinesDAO.findArray({ user: ctx.userId, calendarIntegrationId: integration._id, calendarEventId: { $exists: true } }),
    ]);

    const routineEventIds = new Set(linkedRoutines.map((r) => r.calendarEventId).filter((id): id is string => Boolean(id)));

    const eventsToUpsert = events.filter((e) => !e.recurringEventId || !routineEventIds.has(e.recurringEventId));
    // Each event targets a distinct calendarEventId so there are no write conflicts — safe to parallelize.
    await Promise.all(eventsToUpsert.map((event) => upsertCalendarItem(event, integration, ctx)));
}

async function upsertCalendarItem(
    event: { id: string; title: string; timeStart: string; timeEnd: string; updated: string; status: string },
    integration: CalendarIntegrationInterface,
    ctx: SyncContext,
): Promise<void> {
    const [existing] = await itemsDAO.findArray({ user: ctx.userId, calendarEventId: event.id });

    if (event.status === 'cancelled') {
        if (existing && !existing.routineId) {
            // ItemInterface._id is typed optional but WithId<> from MongoDB always has it set.
            const itemId = existing._id;
            if (!itemId) {
                return;
            }
            await itemsDAO.updateOne({ _id: itemId, user: ctx.userId }, { $set: { status: 'trash', updatedTs: ctx.now } });
            await recordOperation(ctx.userId, {
                entityType: 'item',
                entityId: itemId,
                snapshot: { ...existing, status: 'trash', updatedTs: ctx.now },
                opType: 'update',
                now: ctx.now,
            });
        }
        return;
    }

    if (existing) {
        if (existing.routineId) {
            return; // routine-managed; skip
        }
        // Only update if GCal reports a newer modification — prevents overwriting local edits.
        if (event.updated <= existing.updatedTs) {
            return;
        }
        const itemId = existing._id;
        if (!itemId) {
            return;
        }
        const updated: ItemInterface = { ...existing, title: event.title, timeStart: event.timeStart, timeEnd: event.timeEnd, updatedTs: ctx.now };
        await itemsDAO.replaceById(itemId, updated);
        await recordOperation(ctx.userId, { entityType: 'item', entityId: itemId, snapshot: updated, opType: 'update', now: ctx.now });
        return;
    }

    const itemId = randomUUID();
    const newItem: ItemInterface = {
        _id: itemId,
        user: ctx.userId,
        status: 'calendar',
        title: event.title,
        timeStart: event.timeStart,
        timeEnd: event.timeEnd,
        calendarEventId: event.id,
        calendarIntegrationId: integration._id,
        createdTs: ctx.now,
        updatedTs: ctx.now,
    };
    await itemsDAO.insertOne(newItem);
    await recordOperation(ctx.userId, { entityType: 'item', entityId: itemId, snapshot: newItem, opType: 'create', now: ctx.now });
}

/** Records a server-originated operation so all devices learn about the change via sync pull. */
async function recordOperation(
    userId: string,
    op: { entityType: 'item' | 'routine'; entityId: string; snapshot: ItemInterface | RoutineInterface; opType: 'create' | 'update'; now: string },
): Promise<void> {
    // deviceId: 'server' — server-originated ops have no real device; the sync pull
    // mechanism filters by ts, not deviceId, so this value is just a marker.
    await operationsDAO.insertOne({
        _id: randomUUID(),
        user: userId,
        deviceId: 'server',
        ts: op.now,
        entityType: op.entityType,
        entityId: op.entityId,
        opType: op.opType,
        snapshot: op.snapshot,
    });
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
async function updateItemsAndRecordOps(
    userId: string,
    query: { filter: Record<string, unknown>; setFields: Record<string, unknown> },
    now: string,
): Promise<void> {
    const before = await itemsDAO.findArray(query.filter);
    const ids = before.map((item) => item._id).filter((id): id is string => Boolean(id));
    if (!hasAtLeastOne(ids)) {
        return;
    }
    await itemsDAO.updateMany(query.filter, { $set: query.setFields });
    // Re-fetch by stable ID so the snapshot reflects the post-write state.
    const updated = await itemsDAO.findArray({ _id: { $in: ids }, user: userId });
    await Promise.all(
        updated.flatMap((item) => {
            const itemId = item._id;
            if (!itemId) {
                return [];
            }
            return [recordOperation(userId, { entityType: 'item', entityId: itemId, snapshot: item, opType: 'update', now })];
        }),
    );
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
        await updateItemsAndRecordOps(ctx.userId, { filter: baseFilter, setFields: { status: 'trash', updatedTs: ctx.now } }, ctx.now);
        return;
    }

    if (ex.type === 'modified' && ex.newTimeStart && ex.newTimeEnd) {
        await updateItemsAndRecordOps(
            ctx.userId,
            { filter: baseFilter, setFields: { timeStart: ex.newTimeStart, timeEnd: ex.newTimeEnd, updatedTs: ctx.now } },
            ctx.now,
        );
    }
}

async function syncRoutineExceptions(routine: RoutineInterface, provider: GoogleCalendarProvider, ctx: RoutineSyncCtx): Promise<void> {
    if (!routine.calendarEventId) {
        return;
    }

    const exceptions = await provider.getExceptions(routine.calendarEventId, ctx.calendarId, ctx.since);
    if (!hasAtLeastOne(exceptions)) {
        return;
    }

    const updatedExceptions = exceptions.reduce((acc, ex) => mergeExceptions(acc, ex), [...(routine.routineExceptions ?? [])]);
    // Apply item side-effects in parallel — each exception targets a different date so there
    // are no write conflicts between them.
    const syncCtx: SyncContext = { userId: ctx.userId, now: ctx.now };
    await Promise.all(exceptions.map((ex) => applyExceptionToItems(routine, ex, syncCtx)));

    const updatedRoutine: RoutineInterface = { ...routine, routineExceptions: updatedExceptions, updatedTs: ctx.now };
    await routinesDAO.replaceById(routine._id, updatedRoutine);

    await recordOperation(ctx.userId, { entityType: 'routine', entityId: routine._id, snapshot: updatedRoutine, opType: 'update', now: ctx.now });
}

export { calendarRoutes };
