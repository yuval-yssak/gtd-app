import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(utc);
dayjs.extend(timezone);

import { google } from 'googleapis';
import { type Context, Hono } from 'hono';
import { authenticateRequest } from '../auth/middleware.js';
import type { EventSyncResult, GCalEvent, GCalException } from '../calendarProviders/CalendarProvider.js';
import { SyncTokenInvalidError } from '../calendarProviders/CalendarProvider.js';
import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import { clientUrl } from '../config.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { withAuthFailureHandling } from '../lib/calendarAuthEscalation.js';
import { integrationStatus } from '../lib/calendarIntegrationStatus.js';
import { propagateRoutineNotesToItems } from '../lib/calendarItemNotes.js';
import {
    ensureTimeZone,
    type PushContext,
    type PushOutcome,
    pushItemToGCalWithContext,
    pushRoutineDeletion,
    pushRoutineToGCalWithContext,
} from '../lib/calendarPushback.js';
import { DONE_PREFIX, stripDoneMarker } from '../lib/doneMarker.js';
import { htmlToMarkdown, markdownToHtml } from '../lib/markdownHtml.js';
import { recordOperation } from '../lib/operationHelpers.js';
import { propagateRoutineTitleToItems, regenerateFutureRoutineItems } from '../lib/routineItemRegeneration.js';
import { extractUntilFromRrule } from '../lib/rruleHelpers.js';
import { applyRsvpToAttendees, resolveSyncConfigForItem } from '../lib/rsvpHelpers.js';
import { notifyUserViaSse } from '../lib/sseConnections.js';
import { hasAtLeastOne, type NonEmptyArray } from '../lib/typeUtils.js';
import { notifyViaWebPush } from '../lib/webPush.js';
import { auth } from '../loaders/mainLoader.js';
import type { AuthVariables } from '../types/authTypes.js';
import {
    type CalendarIntegrationInterface,
    type CalendarSyncConfigInterface,
    GCAL_OWNED_ITEM_KEYS,
    type GCalAttendee,
    type GCalEventType,
    type GCalPerson,
    type GCalResponseStatus,
    type ItemInterface,
    type OperationInterface,
    type RoutineInterface,
    type RoutineItemTemplate,
} from '../types/entities.js';

type UnlinkAction = 'keepLinkedEntities' | 'removeLinkedEntities';

/** Parses the disconnect-action query string into a typed UnlinkAction. Defaults to keepLinkedEntities when omitted; rejects unknown values. */
function parseUnlinkAction(raw: string | undefined): UnlinkAction | null {
    if (raw === undefined) {
        return 'keepLinkedEntities';
    }
    if (raw === 'keepLinkedEntities' || raw === 'removeLinkedEntities') {
        return raw;
    }
    return null;
}
export type SyncContext = { userId: string; now: string; ops: OperationInterface[] };
type RoutineSyncCtx = { userId: string; since: string; now: string; calendarId: string; ops: OperationInterface[] };
type UnlinkSideEffectCtx = { userId: string; now: string };
/** Groups the integration + sync config identity needed by import/upsert functions. */
export type CalendarSource = { integration: CalendarIntegrationInterface; config: CalendarSyncConfigInterface };
// Discriminated union to distinguish network failures from missing-token responses in the OAuth flow.
// `grantedScopes` rides along on success when Google's response carried `tokens.scope` (every fresh
// consent emits it). Absent → legacy/permissive at downstream call sites.
type OAuthTokenResult =
    | { ok: true; accessToken: string; refreshToken: string; expiryDate: number | null | undefined; grantedScopes?: string[] }
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

/** Start of today (00:00) in the given IANA timezone, returned as ISO. */
function startOfTodayInTz(nowIso: string, timeZone: string): string {
    return dayjs(nowIso).tz(timeZone).startOf('day').toISOString();
}

/** Returns true if the event ended strictly before `cutoffIso`. */
function isPastEvent(event: { timeEnd: string }, cutoffIso: string): boolean {
    return dayjs(event.timeEnd).isBefore(dayjs(cutoffIso));
}

const calendarRoutes = new Hono<{ Variables: AuthVariables }>();

/**
 * If the integration is `'revoked'`, returns the JSON body for an HTTP 410 Gone response so the
 * client can clear its local sync state and show a reconnect banner. Returns `null` for `'active'`
 * and `'suspended'` — suspended integrations still attempt the operation (24h hasn't elapsed yet);
 * the call-site `withAuthFailureHandling` handles re-escalation if Google still rejects the refresh.
 *
 * Client contract: any 410 + `{ error: 'integration_revoked' }` from a calendar endpoint means
 * "show reconnect banner, hide calendar UI."
 */
function revokedIntegrationBody(integration: CalendarIntegrationInterface) {
    if (integrationStatus(integration) !== 'revoked') {
        return null;
    }
    return {
        error: 'integration_revoked' as const,
        integrationId: integration._id,
        ...(integration.suspendedAt ? { suspendedAt: integration.suspendedAt } : {}),
        ...(integration.revokedAt ? { revokedAt: integration.revokedAt } : {}),
    };
}

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

interface OAuthStatePayload {
    userId: string;
    /** Email of the Google account the user expects to authorize. Verified against userinfo + active session. */
    loginHint?: string;
    /** Caller-supplied hint for what the user came here to do. `'rsvp'` triggers a popup-close redirect target. */
    intent?: 'rsvp';
}

/** Signs a state payload with HMAC-SHA256 to prevent CSRF / userId injection in the OAuth callback. */
function signState(payload: OAuthStatePayload): string {
    const serialized = JSON.stringify(payload);
    const sig = createHmac('sha256', authSecret()).update(serialized).digest('hex');
    return Buffer.from(JSON.stringify({ payload: serialized, sig })).toString('base64url');
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

/** Verifies the HMAC signature and extracts the state payload. Throws if the signature is invalid. */
function verifyState(stateParam: string): OAuthStatePayload {
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
        return JSON.parse(payload) as OAuthStatePayload;
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
function tryVerifyState(stateParam: string): OAuthStatePayload | null {
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
        // Google returns `tokens.scope` as a space-separated string when the consent screen produced
        // a new grant. Absent on some refresh paths; the callback leaves grantedScopes undefined in
        // that case (treated as permissive — legacy integrations).
        const grantedScopes = parseGrantedScopes(tokens.scope);
        return {
            ok: true,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiryDate: tokens.expiry_date,
            ...(grantedScopes ? { grantedScopes } : {}),
        };
    } catch {
        return { ok: false, reason: 'exchange_failed' };
    }
}

/** Splits Google's space-separated `scope` string into a typed array; returns undefined when absent. */
function parseGrantedScopes(scope: string | null | undefined): string[] | undefined {
    if (typeof scope !== 'string' || scope.trim() === '') {
        return undefined;
    }
    return scope.split(/\s+/).filter((s) => s.length > 0);
}

calendarRoutes.get('/auth/google', authenticateRequest, (c) => {
    const oauth2 = buildOAuthClient();
    const userId = c.get('session').user.id;

    // login_hint pre-selects an account in Google's picker. The callback verifies the authorized
    // account email matches both the hint and the active session — preventing a user signed in
    // as a@ from accidentally authorizing an unrelated b@ Google identity.
    const rawHint = c.req.query('login_hint');
    const loginHint = typeof rawHint === 'string' && rawHint.trim() !== '' ? rawHint.trim() : undefined;
    // `intent=rsvp` rides through state so the callback can route to the popup-close finalizer
    // page (versus the normal /settings landing) when an RSVP re-consent popup completes.
    const intent = c.req.query('intent') === 'rsvp' ? ('rsvp' as const) : undefined;

    // state is HMAC-signed so the callback can verify it wasn't tampered with.
    // userinfo.email is required so the callback can verify the authorized account matches
    // the login_hint + active session (mismatch protection); without this scope, the resulting
    // access token can't call /oauth2/v2/userinfo and the connect flow always rejects.
    const url = oauth2.generateAuthUrl({
        access_type: 'offline', // request refresh token
        prompt: 'consent', // always show consent screen so we always get a refresh token
        scope: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/userinfo.email'],
        state: signState({ userId, ...(loginHint ? { loginHint } : {}), ...(intent ? { intent } : {}) }),
        ...(loginHint ? { login_hint: loginHint } : {}),
    });

    return c.redirect(url);
});

calendarRoutes.get('/auth/google/callback', async (c) => {
    const code = c.req.query('code');
    const stateParam = c.req.query('state');
    if (!code || !stateParam) {
        return c.text('Missing code or state', 400);
    }

    const state = tryVerifyState(stateParam);
    if (!state) {
        return c.text('Invalid state parameter', 400);
    }
    const { userId, loginHint, intent } = state;

    const oauth2 = buildOAuthClient();
    const tokenResult = await tryExchangeOAuthTokens(oauth2, code);
    if (!tokenResult.ok) {
        return tokenResult.reason === 'missing_tokens'
            ? c.text('OAuth did not return required tokens', 400)
            : c.text('Failed to exchange OAuth code for tokens', 502);
    }
    const { accessToken, refreshToken, expiryDate, grantedScopes } = tokenResult;

    // Verify the user actually authorized the account they targeted: compare the authorized
    // identity (Google userinfo) against both the login_hint we sent and the active GTD session.
    // Mismatch means the user picked a different account in Google's picker — revoke the just-
    // -granted tokens and bounce back to settings with an error.
    oauth2.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
    const authorizedEmail = await tryFetchAuthorizedEmail(oauth2);
    const sessionEmail = await tryFetchSessionEmail(c.req.raw.headers);
    if (!authorizedEmailMatches(authorizedEmail, loginHint, sessionEmail)) {
        await oauth2.revokeToken(accessToken).catch(() => {});
        if (intent === 'rsvp') {
            return renderPopupCloser(c, { ok: false, reason: 'mismatch' });
        }
        return c.redirect(`${clientUrl}/settings?calendarConnectError=mismatch`);
    }

    const now = dayjs().toISOString();
    const integration: CalendarIntegrationInterface = {
        _id: randomUUID(),
        user: userId,
        provider: 'google',
        accessToken,
        refreshToken,
        tokenExpiry: expiryDate ? dayjs(expiryDate).toISOString() : dayjs().add(1, 'hour').toISOString(),
        // calendarId intentionally omitted — per-calendar state lives on CalendarSyncConfigInterface.
        // The client picks one or more calendars via ChooseCalendarDialog after this redirect.
        createdTs: now,
        updatedTs: now,
        // Reconnect overwrites prior grantedScopes verbatim (no union with the existing list) so a
        // narrowed re-consent is reflected accurately. Absent ⇒ legacy/permissive downstream.
        ...(grantedScopes ? { grantedScopes } : {}),
    };

    await calendarIntegrationsDAO.upsertEncrypted(integration);
    // Reconnect repair pass: clear lastKnown* markers that point at integrations the user no longer
    // has. Without this, an item/routine that was unlinked under one Google account stays "pinned"
    // to that account's integration id forever — a reconnect to a DIFFERENT Google account would
    // never deliver an inbound event id matching the marker, and pushback would permanently skip
    // the entity. The repair runs on every successful OAuth completion (cheap: scoped by user).
    await clearOrphanedLastKnownMarkers(userId);

    // intent=rsvp branch: the OAuth ran in a popup launched by MeetingDetails. Serve a tiny HTML
    // page that posts a message to window.opener and closes itself — saves the parent a 500ms poll
    // and gives a clean visual "popup vanishes on success" UX.
    if (intent === 'rsvp') {
        return renderPopupCloser(c, { ok: true });
    }

    // Redirect back to client settings page so the user sees the new integration.
    return c.redirect(`${clientUrl}/settings?calendarConnected=1`);
});

/**
 * Renders a minimal HTML page that posts an rsvp-reconsent result to the parent window via
 * postMessage, then closes itself. Same-origin restrictions don't apply to postMessage; the parent
 * filters on the message shape + the API origin to authenticate the message.
 */
function renderPopupCloser(c: Context, result: { ok: true } | { ok: false; reason: string }) {
    const payload = JSON.stringify({ type: 'gtd-rsvp-reconsent', ...result });
    // Target origin '*' is acceptable here because the payload contains no secrets — the parent
    // re-fetches /calendar/integrations over its authenticated session to learn the actual scope state.
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>RSVP reconnect</title></head>
<body><script>
try { if (window.opener) { window.opener.postMessage(${payload}, '*'); } } catch (e) {}
setTimeout(() => window.close(), 100);
</script><p>You can close this window.</p></body></html>`;
    return c.html(html);
}

/**
 * Clears `lastKnown*` calendar markers from items and routines whose recorded
 * `lastKnownCalendarIntegrationId` no longer matches any live integration the user owns. Called
 * after each successful OAuth completion — covers the cross-account reconnect case where the
 * user disconnects integration A and later connects integration B. Without this, those entities
 * would be permanently un-pushable (pushback skips them while a marker is set).
 *
 * Also unsets `calendarInstanceEventId` on any routine-generated item whose owning routine was
 * orphaned. The instance id is derived from the OLD master event id (account A's series) and is
 * meaningless after a reconnect to a different account — leaving it in place causes the preferred
 * exception lookup to miss against account B's exceptions, then the fallback's `originalDate`
 * match works on the first move but the second move misses (item's `timeStart` already shifted),
 * triggering a duplicate create-on-miss. Clearing it forces the next inbound sync to either
 * re-mint via regeneration or take create-on-miss exactly once.
 */
async function clearOrphanedLastKnownMarkers(userId: string): Promise<void> {
    const liveIntegrationIds = (await calendarIntegrationsDAO.findArray({ user: userId })).map((i) => i._id);
    const orphanFilter = { user: userId, lastKnownCalendarIntegrationId: { $exists: true, $nin: liveIntegrationIds } } as const;
    const unsetMarkers = {
        $unset: { lastKnownCalendarEventId: '', lastKnownCalendarIntegrationId: '', lastKnownCalendarSyncConfigId: '' },
        $set: { updatedTs: dayjs().toISOString() },
    } as const;

    // Snapshot the orphaned entities first so we can record per-entity operations after the wipe.
    // Without ops, other devices would keep the stale `lastKnown*` markers in their local IDB and
    // their pushback would stay permanently skipped — defeating the whole purpose of the repair pass.
    const [orphanItems, orphanRoutines] = await Promise.all([itemsDAO.findArray(orphanFilter), routinesDAO.findArray(orphanFilter)]);
    if (!hasAtLeastOne(orphanItems) && !hasAtLeastOne(orphanRoutines)) {
        return;
    }
    await Promise.all([itemsDAO.updateMany(orphanFilter, unsetMarkers), routinesDAO.updateMany(orphanFilter, unsetMarkers)]);
    // Cross-account hygiene: wipe `calendarInstanceEventId` on items whose routine just had its
    // marker cleared. Their instance ids were derived from the defunct master event id.
    const orphanedRoutineIds = orphanRoutines.map((r) => r._id);
    const refreshedItems = hasAtLeastOne(orphanedRoutineIds) ? await clearStaleInstanceIdsForRoutines(userId, orphanedRoutineIds) : [];
    await recordRepairOpsForOrphans(userId, [...orphanItems, ...refreshedItems], orphanRoutines);
}

/**
 * For each given routineId, unsets `calendarInstanceEventId` on all of its items and returns the
 * post-wipe snapshots so the caller can record ops. Overlap with `orphanItems` from
 * `clearOrphanedLastKnownMarkers` is fine — `recordRepairOpsForOrphans` dedupes by `_id`.
 */
async function clearStaleInstanceIdsForRoutines(userId: string, routineIds: NonEmptyArray<string>): Promise<ItemInterface[]> {
    const filter = { user: userId, routineId: { $in: routineIds }, calendarInstanceEventId: { $exists: true } } as const;
    const before = await itemsDAO.findArray(filter);
    if (!hasAtLeastOne(before)) {
        return [];
    }
    await itemsDAO.updateMany(filter, { $unset: { calendarInstanceEventId: '' }, $set: { updatedTs: dayjs().toISOString() } });
    return itemsDAO.findArray({ _id: { $in: before.map((i) => i._id) }, user: userId } as never);
}

/**
 * Re-fetches each repaired entity and records an `update` op so the operations log advertises the
 * cleared markers to every other device for this user. Uses post-wipe snapshots so the op carries
 * the correct (no-marker) state — recording the pre-wipe snapshot would propagate the stale data.
 */
async function recordRepairOpsForOrphans(userId: string, orphanItems: ItemInterface[], orphanRoutines: RoutineInterface[]): Promise<void> {
    const now = dayjs().toISOString();
    // Dedupe by _id — the caller may pass an item twice (once for its own lastKnown* marker,
    // once because its routine's instance id was wiped). Recording two ops would double-bump
    // updatedTs and confuse last-write-wins.
    const seen = new Set<string>();
    const itemOpPromises = orphanItems.flatMap((item) => {
        if (!item._id || seen.has(item._id)) {
            return [];
        }
        seen.add(item._id);
        return [recordRepairOp(userId, 'item', item._id, now)];
    });
    const routineOpPromises = orphanRoutines.map((routine) => recordRepairOp(userId, 'routine', routine._id, now));
    await Promise.all([...itemOpPromises, ...routineOpPromises]);
}

async function recordRepairOp(userId: string, entityType: 'item' | 'routine', entityId: string, now: string): Promise<void> {
    const dao = entityType === 'item' ? itemsDAO : routinesDAO;
    const fresh = await dao.findByOwnerAndId(entityId, userId);
    if (!fresh) {
        return;
    }
    await recordOperation(userId, { entityType, entityId, snapshot: fresh, opType: 'update', now });
}

/** Reads the authorized account email from Google's userinfo endpoint. Returns null on any error. */
async function tryFetchAuthorizedEmail(oauth2: ReturnType<typeof buildOAuthClient>): Promise<string | null> {
    try {
        const { data } = await google.oauth2({ auth: oauth2, version: 'v2' }).userinfo.get();
        return typeof data.email === 'string' ? data.email : null;
    } catch (err) {
        console.error('[calendar] failed to fetch authorized userinfo:', err);
        return null;
    }
}

/** Resolves the active Better Auth session email from the request cookies. Returns null if no session. */
async function tryFetchSessionEmail(headers: Headers): Promise<string | null> {
    try {
        const session = await auth.api.getSession({ headers });
        return session?.user.email ?? null;
    } catch {
        return null;
    }
}

/**
 * All three of (authorizedEmail, loginHint, sessionEmail) must match case-insensitively for the
 * connect to proceed. authorizedEmail is required (we just got it from Google). loginHint and
 * sessionEmail are each compared when present — but at least one must match so we don't allow a
 * silent fallback to "no validation" if userinfo or session resolution fails.
 */
function authorizedEmailMatches(authorizedEmail: string | null, loginHint: string | undefined, sessionEmail: string | null): boolean {
    if (!authorizedEmail) {
        return false;
    }
    const authorized = authorizedEmail.toLowerCase();
    if (loginHint && authorized !== loginHint.toLowerCase()) {
        return false;
    }
    if (sessionEmail && authorized !== sessionEmail.toLowerCase()) {
        return false;
    }
    // Require at least one corroborating source so a missing session + missing hint can't
    // accept any authorized account.
    return Boolean(loginHint) || Boolean(sessionEmail);
}

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

/**
 * Resolves the default calendar ID for an integration by reading the default sync config first,
 * falling back to the deprecated `integration.calendarId` for legacy rows.
 * Returns null when neither source has a value (caller should reject the request).
 */
async function resolveDefaultCalendarId(integrationId: string, integration: CalendarIntegrationInterface): Promise<string | null> {
    const configs = await calendarSyncConfigsDAO.findEnabledByIntegration(integrationId);
    const defaultConfig = configs.find((c) => c.isDefault) ?? configs[0];
    return defaultConfig?.calendarId ?? integration.calendarId ?? null;
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

// ── Aggregated sync configs across all logged-in accounts on this device ─────
//
// Used by the unified calendar picker — the picker needs to show every connected
// integration + sync config for every Better Auth session present on this device,
// not just the active one. Authenticates normally; the multi-session cookie tells
// us which other sessions exist, and we aggregate per-user data from there.
type IntegrationWithConfigs = Omit<CalendarIntegrationInterface, 'accessToken' | 'refreshToken'> & {
    syncConfigs: CalendarSyncConfigInterface[];
};
type AccountSyncConfigsBundle = {
    userId: string;
    accountEmail: string;
    integrations: IntegrationWithConfigs[];
};

/** Strips OAuth tokens from a decrypted integration row before sending to the client. */
function stripIntegrationTokens(integration: CalendarIntegrationInterface): Omit<CalendarIntegrationInterface, 'accessToken' | 'refreshToken'> {
    const { accessToken: _a, refreshToken: _r, ...rest } = integration;
    return rest;
}

/** Fetches one user's integrations + sync configs and pairs them. Used inside the per-session aggregation. */
async function loadIntegrationsWithConfigs(userId: string): Promise<IntegrationWithConfigs[]> {
    const integrations = await calendarIntegrationsDAO.findByUserDecrypted(userId);
    // Lazy migration parity with /integrations — keep behavior consistent across reads.
    await Promise.all(integrations.map((integration) => ensureSyncConfigExists(integration)));
    const allConfigs = await calendarSyncConfigsDAO.findByUser(userId);
    return integrations.map((integration) => ({
        ...stripIntegrationTokens(integration),
        syncConfigs: allConfigs.filter((config) => config.integrationId === integration._id),
    }));
}

calendarRoutes.get('/all-sync-configs', authenticateRequest, async (c) => {
    const sessions = await auth.api.listDeviceSessions({ headers: c.req.raw.headers });
    // De-duplicate by userId — a single user can have multiple sessions on one device
    // (e.g. after a session-revoke + re-auth for the same email). We only want one bundle per user.
    const seen = new Set<string>();
    const bundles = await Promise.all(
        sessions
            .filter((s) => {
                if (seen.has(s.user.id)) {
                    return false;
                }
                seen.add(s.user.id);
                return true;
            })
            .map(
                async (s): Promise<AccountSyncConfigsBundle> => ({
                    userId: s.user.id,
                    accountEmail: s.user.email,
                    integrations: await loadIntegrationsWithConfigs(s.user.id),
                }),
            ),
    );
    return c.json(bundles);
});

/**
 * Disconnect-with-keep orchestrator. Two sibling passes operate on disjoint slices of the docs
 * matched by `baseFilter`:
 *
 *  - `renameCalendarLinkFieldsToLastKnown` — docs WITH `calendarEventId`. Renames all three
 *    `calendar*` fields to their `lastKnown*` counterparts so a later reconnect can do a
 *    strong-key relink. The `calendarEventId: { $exists: true }` predicate also protects an
 *    already-renamed second-disconnect from clobbering a previously-stored
 *    `lastKnownCalendarEventId`.
 *  - `unsetUnpushedCalendarLinkFields` — docs WITHOUT `calendarEventId` (linked at the integration
 *    level but never pushed to GCal yet). Nothing to preserve, but they must still be unlinked so
 *    they don't keep pointing at a now-defunct integration.
 *
 * Both passes share the `$set: { updatedTs }` bump so sync picks up the change.
 */
type CalendarLinkDAO = { updateMany: (filter: object, update: object) => Promise<unknown> };

async function renameOrUnsetCalendarLinkFields(dao: CalendarLinkDAO, baseFilter: object, now: string): Promise<void> {
    await Promise.all([renameCalendarLinkFieldsToLastKnown(dao, baseFilter, now), unsetUnpushedCalendarLinkFields(dao, baseFilter, now)]);
}

async function renameCalendarLinkFieldsToLastKnown(dao: CalendarLinkDAO, baseFilter: object, now: string): Promise<void> {
    await dao.updateMany(
        { ...baseFilter, calendarEventId: { $exists: true } },
        {
            $rename: {
                calendarEventId: 'lastKnownCalendarEventId',
                calendarIntegrationId: 'lastKnownCalendarIntegrationId',
                calendarSyncConfigId: 'lastKnownCalendarSyncConfigId',
            },
            $set: { updatedTs: now },
        },
    );
}

async function unsetUnpushedCalendarLinkFields(dao: CalendarLinkDAO, baseFilter: object, now: string): Promise<void> {
    await dao.updateMany(
        { ...baseFilter, calendarEventId: { $exists: false } },
        { $unset: { calendarIntegrationId: '', calendarSyncConfigId: '' }, $set: { updatedTs: now } },
    );
}

/**
 * Handles the `removeLinkedEntities` disconnect path for items:
 * - Items with status 'done' are treated as terminal — they are unlinked (calendar fields cleared)
 *   but kept as 'done', so a later GCal reconnect will not resurrect them as live calendar items.
 * - All other linked items are trashed.
 * Records ops for cross-device convergence. Never touches GCal.
 */
async function trashItemsForIntegration(userId: string, integrationId: string, now: string): Promise<void> {
    const linked = await itemsDAO.findArray({ user: userId, calendarIntegrationId: integrationId });
    if (!hasAtLeastOne(linked)) {
        return;
    }
    const openIds = linked
        .filter((item) => item.status !== 'done')
        .map((item) => item._id)
        .filter((id): id is string => Boolean(id));
    const doneIds = linked
        .filter((item) => item.status === 'done')
        .map((item) => item._id)
        .filter((id): id is string => Boolean(id));

    if (hasAtLeastOne(openIds)) {
        await itemsDAO.updateMany({ _id: { $in: openIds }, user: userId }, { $set: { status: 'trash', updatedTs: now } });
    }
    if (hasAtLeastOne(doneIds)) {
        // Done items: unlink only (clear calendar fields, status stays 'done'). Same shape as
        // the keepLinkedEntities path, so reconnect won't create a duplicate or revive the item.
        await renameOrUnsetCalendarLinkFields(itemsDAO, { _id: { $in: doneIds }, user: userId }, now);
    }

    // Re-fetch so operation snapshots reflect the persisted state.
    const allIds = [...openIds, ...doneIds];
    if (!hasAtLeastOne(allIds)) {
        return;
    }
    const updated = await itemsDAO.findArray({ _id: { $in: allIds }, user: userId });
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

/**
 * Handles app-side cleanup when the user disconnects. Never touches GCal.
 * - keepLinkedEntities: items + routines stay; their calendar links are cleared (`unlinkItems` + `unlinkRoutines`).
 * - removeLinkedEntities: items and routines are trashed. Routine cascade reuses `pushRoutineDeletion`
 *   with `skipGCalDelete` so the GCal master events are preserved.
 */
async function applyUnlinkSideEffects(action: UnlinkAction, integrationId: string, routines: RoutineInterface[], ctx: UnlinkSideEffectCtx): Promise<void> {
    if (action === 'keepLinkedEntities') {
        await unlinkItems(ctx.userId, integrationId, ctx.now);
        await unlinkRoutines(ctx.userId, routines, ctx.now);
        return;
    }
    // removeLinkedEntities: trash items first, then trash routines + cascade their generated items.
    await trashItemsForIntegration(ctx.userId, integrationId, ctx.now);
    await trashRoutinesForIntegration(ctx.userId, routines, ctx.now);
}

/**
 * Clears `calendarEventId` / `calendarIntegrationId` / `calendarSyncConfigId` on every item linked
 * to the integration, leaving the item's status untouched. Records ops for cross-device convergence.
 * Parallel to `unlinkRoutines` — both publish the cleared snapshot via the operation log.
 */
async function unlinkItems(userId: string, integrationId: string, now: string): Promise<void> {
    const linked = await itemsDAO.findArray({ user: userId, calendarIntegrationId: integrationId });
    const ids = linked.map((item) => item._id).filter((id): id is string => Boolean(id));
    if (!hasAtLeastOne(ids)) {
        return;
    }
    await renameOrUnsetCalendarLinkFields(itemsDAO, { _id: { $in: ids }, user: userId }, now);
    // Re-fetch by stable IDs so snapshots reflect the cleared fields.
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

/**
 * Trashes routines linked to the integration and cascades generated items via `pushRoutineDeletion`,
 * passing `skipGCalDelete: true` so the GCal master event is preserved (disconnect must never touch GCal).
 */
async function trashRoutinesForIntegration(userId: string, routines: RoutineInterface[], now: string): Promise<void> {
    if (!hasAtLeastOne(routines)) {
        return;
    }
    const ids = routines.map((r) => r._id);
    await routinesDAO.updateMany({ _id: { $in: ids }, user: userId }, { $set: { active: false, updatedTs: now } });
    const updated = await routinesDAO.findArray({ _id: { $in: ids }, user: userId });
    await Promise.all(
        updated.map(async (r) => {
            await recordOperation(userId, { entityType: 'routine', entityId: r._id, snapshot: r, opType: 'update', now });
            // Cascade generated items via the existing routine-delete cascade, but skip the GCal call.
            await pushRoutineDeletion(r, userId, () => buildLocalProvider(), { skipGCalDelete: true });
        }),
    );
}

/**
 * Local provider stub used when `pushRoutineDeletion` is invoked with `skipGCalDelete: true` — no
 * GCal call will be made, but the function signature still requires a provider factory. Throws if
 * accidentally invoked, surfacing the bug rather than silently calling Google.
 */
function buildLocalProvider(): GoogleCalendarProvider {
    throw new Error('buildLocalProvider must not be invoked — disconnect path uses skipGCalDelete=true');
}

/** Clears calendarEventId and calendarIntegrationId from routines in the DB and records operations so other devices sync the cleared fields. */
async function unlinkRoutines(userId: string, routines: RoutineInterface[], now: string): Promise<void> {
    await Promise.all(routines.map((r) => renameOrUnsetCalendarLinkFields(routinesDAO, { _id: r._id, user: userId }, now)));
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
    const action = parseUnlinkAction(c.req.query('action'));
    if (!action) {
        return c.json({ error: 'Invalid action — must be keepLinkedEntities or removeLinkedEntities' }, 400);
    }

    const integration = await calendarIntegrationsDAO.findByOwnerAndIdDecrypted(integrationId, userId);
    if (!integration) {
        return c.json({ error: 'Integration not found' }, 404);
    }

    const now = dayjs().toISOString();
    const provider = buildProvider(integration, userId);
    const linkedRoutines = await routinesDAO.findArray({ user: userId, calendarIntegrationId: integrationId });

    await applyUnlinkSideEffects(action, integrationId, linkedRoutines, { userId, now });
    // Stop all webhook channels before deleting configs so Google stops sending notifications.
    const configs = await calendarSyncConfigsDAO.findByIntegration(integrationId);
    await Promise.all(configs.map((cfg) => teardownWatch(cfg, provider, integration._id).catch(() => {})));
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
    const revokedBody = revokedIntegrationBody(integration);
    if (revokedBody) {
        return c.json(revokedBody, 410);
    }

    try {
        const provider = buildProvider(integration, userId);
        const calendars = await withAuthFailureHandling(integration._id, () => provider.listCalendars());
        return c.json(calendars);
    } catch (err) {
        console.error(`[calendar] listCalendars failed for integration ${integrationId}:`, err);
        return c.json({ error: 'Failed to fetch calendars from Google' }, 502);
    }
});

// ── Sync config management ───────────────────────────────────────────────────

/**
 * Creates a default CalendarSyncConfig for an integration if none exists yet.
 *
 * Lazy migration for legacy integrations created before multi-calendar support — those rows have
 * `integration.calendarId` set, which we use to seed the config. New (Step 2+) integrations skip
 * this path because `calendarId` is no longer written; instead, the client picks one or more
 * calendars via `ChooseCalendarDialog` immediately after the OAuth redirect.
 */
async function ensureSyncConfigExists(integration: CalendarIntegrationInterface): Promise<void> {
    const existing = await calendarSyncConfigsDAO.findByIntegration(integration._id);
    if (hasAtLeastOne(existing)) {
        return;
    }
    if (!integration.calendarId) {
        // New-style integration awaiting an explicit calendar choice — nothing to migrate.
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
    const revokedBody = revokedIntegrationBody(integration);
    if (revokedBody) {
        return c.json(revokedBody, 410);
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
    // Skip setup if the integration is suspended — pushing more provider calls would just re-trigger
    // the same invalid_grant. The next OAuth reconnect or sync flips status back to active.
    if (integrationStatus(integration) === 'active') {
        const provider = buildProvider(integration, userId);
        await setupWatch(config, provider, integration._id).catch((err) => {
            console.error(`[calendar] setupWatch failed for config ${configId}:`, err);
        });
    }

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
    const revokedBody = revokedIntegrationBody(integration);
    if (revokedBody) {
        return c.json(revokedBody, 410);
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
        await setupWatch(config, provider, integration._id).catch((err) => {
            console.error(`[calendar] setupWatch failed for config ${configId}:`, err);
        });
    } else if (disablingWatch) {
        await teardownWatch(config, provider, integration._id).catch((err) => {
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
    await teardownWatch(config, provider, integration._id).catch((err) => {
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
    integrationId: string,
): Promise<CreateEventResult> {
    try {
        const calendarEventId = await withAuthFailureHandling(integrationId, () => provider.createRecurringEvent(routine, calendarId, timeZone));
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
    const revokedBody = revokedIntegrationBody(integration);
    if (revokedBody) {
        return c.json(revokedBody, 410);
    }

    // Resolve the target calendar from the integration's default sync config — Step 2 deprecates
    // `integration.calendarId`, so new integrations only have it on the sync config. Falls back to
    // the legacy field for pre-Step-2 rows still in the DB.
    const targetCalendarId = await resolveDefaultCalendarId(integrationId, integration);
    if (!targetCalendarId) {
        return c.json({ error: 'Integration has no default calendar selected' }, 400);
    }

    const provider = buildProvider(integration, userId);
    const timeZone = await withAuthFailureHandling(integration._id, () => resolveTimeZoneForIntegration(integrationId, provider, targetCalendarId));
    const createResult = await tryCreateRecurringEvent(provider, routine, targetCalendarId, timeZone, integration._id);
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

// Returns HTTP 410 Gone when the integration is `'revoked'` so the client can clear local sync
// state and prompt for reconnect. `'suspended'` integrations still attempt the sync — the call-site
// `withAuthFailureHandling` re-escalates on persistent failure and revokes after the 24h grace.
calendarRoutes.post('/integrations/:id/sync', authenticateRequest, async (c) => {
    const userId = c.get('session').user.id;
    const integrationId = c.req.param('id');

    const integration = await calendarIntegrationsDAO.findByOwnerAndIdDecrypted(integrationId, userId);
    if (!integration) {
        return c.json({ error: 'Integration not found' }, 404);
    }
    const revokedBody = revokedIntegrationBody(integration);
    if (revokedBody) {
        return c.json(revokedBody, 410);
    }

    try {
        const provider = buildProvider(integration, userId);
        const configs = await calendarSyncConfigsDAO.findEnabledByIntegration(integrationId);
        const now = dayjs().toISOString();
        // Aggregate ops across configs so a single SSE notify covers the whole manual sync —
        // mirrors the webhook path's behavior so the calling client always learns to pull.
        const ops: OperationInterface[] = [];

        // Sync each enabled calendar independently — each has its own lastSyncedTs cursor.
        // Sequential to avoid overwhelming Google's API with parallel requests per-account.
        const syncResults = await configs.reduce(async (prevPromise, config) => {
            const prev = await prevPromise;
            const count = await withAuthFailureHandling(integration._id, () => syncSingleCalendar(config, integration, provider, { userId, now, ops }));
            // Keep webhook channel alive — renew if expired or expiring soon.
            await renewWebhookIfExpired(config, provider, integration._id).catch((err) => {
                console.error(`[calendar] renewWebhookIfExpired failed for config ${config._id}:`, err);
            });
            return prev + count;
        }, Promise.resolve(0));

        // Outbound backfill: push app-created calendar items / routines that have never been
        // linked to a GCal event. Without this, "Sync now" is one-way (Google → app); a user who
        // creates calendar entities before connecting Google never sees them on their calendar.
        // Scoped to the default config because that's where new entities normally land — see
        // resolveDefaultPushContext semantics in calendarPushback.ts. The default config's
        // timeZone is refreshed in-place by syncSingleCalendar above, so the `?? 'UTC'` fallback
        // is unreachable in practice — kept for defensive narrowing.
        const defaultConfig = configs.find((cfg) => cfg.isDefault);
        const backfill = defaultConfig
            ? await runOutboundBackfill(
                  {
                      integration,
                      config: defaultConfig,
                      provider,
                      timeZone: defaultConfig.timeZone ?? 'UTC',
                  },
                  userId,
              )
            : { pushedItems: 0, pushedRoutines: 0, recordedOps: [] };

        // Both the inbound import path and the backfill path produce ops via recordOperation; we
        // need both fed into the SSE + web push fan-out so live tabs refresh AND closed-tab
        // devices learn to pull. Mirrors the documented "single notification fan-out covers both"
        // contract in api-server/CLAUDE.md (Public API conventions).
        const allOps = [...ops, ...backfill.recordedOps];
        if (allOps.length > 0) {
            console.log(
                `[calendar] manual sync produced ops — notifying SSE + push | userId=${userId} inboundOps=${ops.length} pushedItems=${backfill.pushedItems} pushedRoutines=${backfill.pushedRoutines}`,
            );
            notifyUserViaSse(userId, { type: 'update', ts: now });
            await notifyViaWebPush(userId, null, allOps, now).catch((err) => {
                console.error(`[calendar] web push failed for user ${userId}:`, err);
            });
        }

        return c.json({
            ok: true,
            syncedRoutines: syncResults,
            syncedCalendars: configs.length,
            pushedItems: backfill.pushedItems,
            pushedRoutines: backfill.pushedRoutines,
        });
    } catch (err) {
        console.error(`[calendar] sync failed for integration ${integrationId}:`, err);
        return c.json({ error: 'Failed to sync with Google Calendar' }, 502);
    }
});

/** Inter-call pacing for backfill push loops. ~7 req/s sustained, well under GCal's 600/min/user. */
const BACKFILL_PACE_MS = 150;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface BackfillResult {
    pushedItems: number;
    pushedRoutines: number;
    recordedOps: OperationInterface[];
}

/**
 * Runs the outbound backfill: push app-created calendar items + routines that have never been
 * linked to a GCal event. Returns counts and the recorded ops for downstream notification.
 */
async function runOutboundBackfill(ctx: PushContext, userId: string): Promise<BackfillResult> {
    // The `routineId: { $exists: false }` exclusion mirrors the guard in handleItemPush —
    // routine-generated items don't have their own GCal event; their presence is the routine's
    // recurring series. The `calendarEventId: { $exists: false }` filter is also the idempotency
    // gate: entities already linked from a previous run are skipped without a Google round-trip.
    const [items, routines] = await Promise.all([
        itemsDAO.findArray({
            user: userId,
            status: 'calendar',
            calendarEventId: { $exists: false },
            routineId: { $exists: false },
        }),
        routinesDAO.findArray({
            user: userId,
            routineType: 'calendar',
            calendarEventId: { $exists: false },
            // Mirror handleRoutinePush's inactive-skip semantics — capped/paused routines don't push.
            active: { $ne: false },
        }),
    ]);
    if (items.length + routines.length === 0) {
        return { pushedItems: 0, pushedRoutines: 0, recordedOps: [] };
    }
    console.log(`[calendar] backfilling | userId=${userId} items=${items.length} routines=${routines.length}`);
    const itemOutcomes = await pushPaced(items, (item) => pushItemToGCalWithContext(item, ctx, userId));
    const routineOutcomes = await pushPaced(routines, (routine) => pushRoutineToGCalWithContext(routine, ctx, userId));
    const all = [...itemOutcomes, ...routineOutcomes];
    const pushedItems = itemOutcomes.filter((o) => o.status === 'created').length;
    const pushedRoutines = routineOutcomes.filter((o) => o.status === 'created').length;
    const recordedOps = all.flatMap((o) => (o.recordedOp ? [o.recordedOp] : []));
    console.log(`[calendar] backfill complete | pushedItems=${pushedItems} pushedRoutines=${pushedRoutines}`);
    return { pushedItems, pushedRoutines, recordedOps };
}

/** Sequentially pushes each entity through `push`, sleeping between calls to pace under GCal's rate limit. */
async function pushPaced<T>(entities: T[], push: (entity: T) => Promise<PushOutcome>): Promise<PushOutcome[]> {
    return entities.reduce<Promise<PushOutcome[]>>(async (prevP, entity, i) => {
        const prev = await prevP;
        if (i > 0) {
            await sleep(BACKFILL_PACE_MS);
        }
        const outcome = await push(entity);
        return [...prev, outcome];
    }, Promise.resolve([]));
}

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
    // Full-sync timeMin uses start-of-today (in the calendar's timezone) so events earlier today
    // are still returned. Without this, GCal's `timeMin=now` filter drops them at the API layer.
    const timeMin = startOfTodayInTz(now, config.timeZone ?? 'UTC');
    if (config.syncToken) {
        try {
            return await provider.listEventsIncremental(config.calendarId, config.syncToken);
        } catch (err) {
            if (err instanceof SyncTokenInvalidError) {
                console.warn(`[calendar] syncToken expired for config ${config._id}, falling back to full sync`);
                await calendarSyncConfigsDAO.upsertSyncToken(config._id, '', config.lastSyncedTs ?? dayjs(0).toISOString());
                return provider.listEventsFull(config.calendarId, timeMin);
            }
            throw err;
        }
    }
    return provider.listEventsFull(config.calendarId, timeMin);
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

const normalizeTitle = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Pick the most likely parent routine for a newly-imported GCal recurring master that looks like
 * a "this and following" split tail. Google exposes no lineage signal linking the new master to
 * the original, so we stack heuristics: same sync config, tight 0–1 day gap between the
 * original's UNTIL and the tail's first occurrence, and an exact normalized title match.
 * Ties broken by smallest absolute gap, then by _id for determinism.
 *
 * We deliberately do NOT compare BYDAY: the whole point of "this and following" is that the user
 * changed the schedule (often the weekday), so a MO→TU split would be the expected pattern and
 * any disjoint-weekday veto would false-negative exactly the real splits we need to detect.
 *
 * Exported for unit testing.
 */
export function pickSplitParent(args: {
    tail: { title: string; rrule: string; calendarSyncConfigId: string | undefined; tailStart: string };
    candidates: RoutineInterface[];
}): RoutineInterface | null {
    const tailTitleNorm = normalizeTitle(args.tail.title);
    const tailStartDay = dayjs(args.tail.tailStart).startOf('day');

    const passing = args.candidates.flatMap((candidate) => {
        if (candidate.calendarSyncConfigId !== args.tail.calendarSyncConfigId) {
            return [];
        }
        const until = extractUntilFromRrule(candidate.rrule);
        if (!until) {
            return [];
        }
        const gapDays = tailStartDay.diff(dayjs(until).startOf('day'), 'day');
        if (gapDays < 0 || gapDays > 1) {
            return [];
        }
        if (normalizeTitle(candidate.title) !== tailTitleNorm) {
            return [];
        }
        return [{ candidate, gapAbsMs: Math.abs(dayjs(args.tail.tailStart).diff(dayjs(until))) }];
    });

    if (!hasAtLeastOne(passing)) {
        return null;
    }
    passing.sort((a, b) => a.gapAbsMs - b.gapAbsMs || a.candidate._id.localeCompare(b.candidate._id));
    return passing[0].candidate;
}

/**
 * Detect GCal series splits: when "this and all following" is used in GCal, the original series
 * gains UNTIL and a new master is created. Link the new routine to the original via splitFromRoutineId
 * by running pickSplitParent against existing capped candidates.
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

    const parentCandidates = routinesAfterImport.filter((r) => existingIds.has(r._id) && r.rrule.includes('UNTIL='));

    for (const tail of newRoutines) {
        if (tail.splitFromRoutineId) {
            continue;
        }

        const event = masterEvents.find((e) => e.id === tail.calendarEventId);
        if (!event) {
            continue;
        }

        const parent = pickSplitParent({
            tail: { title: tail.title, rrule: tail.rrule, calendarSyncConfigId: tail.calendarSyncConfigId, tailStart: event.timeStart },
            candidates: parentCandidates,
        });
        if (!parent) {
            continue;
        }

        const linked: RoutineInterface = { ...tail, splitFromRoutineId: parent._id, updatedTs: ctx.now };
        await routinesDAO.replaceById(tail._id, linked);
        ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'routine', entityId: tail._id, snapshot: linked, opType: 'update', now: ctx.now }));
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
    const rrule = event.status === 'cancelled' ? null : extractRrule(event.recurrence ?? []);

    const existing = await findExistingRoutineForEvent(event, rrule, source, ctx);

    if (existing?.lastPushedToGCalTs && isOwnEcho(existing.lastPushedToGCalTs, event.updated)) {
        return;
    }

    if (event.status === 'cancelled') {
        console.log(`[gcal-sync] deactivating routine | eventId=${event.id} title=${event.title}`);
        await deactivateRoutineFromGCal(existing, ctx);
        return;
    }

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

/**
 * Two-stage routine reconciliation, mirroring `findExistingCalendarItem` for items.
 *  1. Match by (user, calendarEventId, calendarIntegrationId) — strong key.
 *  2. On miss, match a naked active routine — title + rrule + timeOfDay + duration must all
 *     line up — and relink it. Covers reconnect-after-keepLinkedEntities for routines.
 *  Skips the naked search for cancelled events (no rrule available, and there is nothing to relink to).
 */
async function findExistingRoutineForEvent(
    event: GCalEvent,
    rrule: string | null,
    source: CalendarSource,
    ctx: SyncContext,
): Promise<RoutineInterface | undefined> {
    const [byEventId] = await routinesDAO.findArray({
        user: ctx.userId,
        calendarEventId: event.id,
        calendarIntegrationId: source.integration._id,
    });
    if (byEventId) {
        return byEventId;
    }
    // Skip restore for cancelled masters — there's nothing to restore TO, and the caller will
    // immediately deactivate. Restoring then deactivating would emit a redundant op + flap.
    // Mirrors the naked-search skip below.
    if (event.status === 'cancelled') {
        return undefined;
    }
    // Strong-key restore: a routine whose link was renamed to lastKnown* on disconnect gets atomically
    // restored when the GCal master event re-imports. Mirrors `tryRestoreFromLastKnownEventId` for items.
    const restored = await tryRestoreRoutineFromLastKnownEventId(event, source, ctx);
    if (restored || !rrule) {
        return restored;
    }
    const timeOfDay = extractLocalTime(event.timeStart, source.config.timeZone ?? 'UTC');
    const duration = dayjs(event.timeEnd).diff(dayjs(event.timeStart), 'minute');
    const naked = await routinesDAO.findArray({
        user: ctx.userId,
        active: true,
        routineType: 'calendar',
        calendarEventId: { $exists: false },
        calendarIntegrationId: { $exists: false },
        title: event.title,
        rrule,
        'calendarItemTemplate.timeOfDay': timeOfDay,
        'calendarItemTemplate.duration': duration,
    });
    if (!hasAtLeastOne(naked)) {
        return undefined;
    }
    const best = pickMostRecentlyUpdated(naked);
    return await relinkRoutineToEvent(best, event, source, ctx);
}

/**
 * Strong-key restore for routines: atomically rebinds a routine whose calendar link was renamed
 * to `lastKnown*` on disconnect-with-keep, when the matching GCal master event re-imports. TOCTOU-safe
 * via the conditional update on `lastKnownCalendarEventId` — a concurrent restore wins, the loser
 * returns undefined.
 */
async function tryRestoreRoutineFromLastKnownEventId(event: GCalEvent, source: CalendarSource, ctx: SyncContext): Promise<RoutineInterface | undefined> {
    const [candidate] = await routinesDAO.findArray({ user: ctx.userId, lastKnownCalendarEventId: event.id });
    if (!candidate) {
        return undefined;
    }
    const result = await routinesDAO.updateOne(
        { _id: candidate._id, user: ctx.userId, lastKnownCalendarEventId: event.id },
        {
            $set: {
                calendarEventId: event.id,
                calendarIntegrationId: source.integration._id,
                calendarSyncConfigId: source.config._id,
                updatedTs: ctx.now,
            },
            $unset: { lastKnownCalendarEventId: '', lastKnownCalendarIntegrationId: '', lastKnownCalendarSyncConfigId: '' },
        },
    );
    if (result.matchedCount === 0) {
        return undefined;
    }
    const restored = await routinesDAO.findByOwnerAndId(candidate._id, ctx.userId);
    if (!restored) {
        return undefined;
    }
    ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'routine', entityId: candidate._id, snapshot: restored, opType: 'update', now: ctx.now }));
    console.log(`[gcal-sync] restored routine from lastKnownCalendarEventId | routineId=${candidate._id} eventId=${event.id} title="${event.title}"`);
    return restored;
}

/**
 * Conditional relink — same TOCTOU pattern as `relinkBestNakedCandidate` for items. If a concurrent
 * webhook already claimed this routine, our $set matches 0 docs and we return undefined; the caller
 * falls through to `createRoutineFromGCal`. Better duplicate routine than silent overwrite.
 */
async function relinkRoutineToEvent(
    routine: RoutineInterface,
    event: GCalEvent,
    source: CalendarSource,
    ctx: SyncContext,
): Promise<RoutineInterface | undefined> {
    const result = await routinesDAO.updateOne(
        { _id: routine._id, user: ctx.userId, calendarEventId: { $exists: false }, calendarIntegrationId: { $exists: false } },
        {
            $set: {
                calendarEventId: event.id,
                calendarIntegrationId: source.integration._id,
                calendarSyncConfigId: source.config._id,
                updatedTs: ctx.now,
            },
        },
    );
    if (result.matchedCount === 0) {
        return undefined;
    }
    const relinked = await routinesDAO.findByOwnerAndId(routine._id, ctx.userId);
    if (!relinked) {
        return undefined;
    }
    ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'routine', entityId: routine._id, snapshot: relinked, opType: 'update', now: ctx.now }));
    console.log(`[gcal-sync] relinked naked routine to GCal event | routineId=${routine._id} eventId=${event.id} title="${event.title}"`);
    return relinked;
}

async function createRoutineFromGCal(event: GCalEvent, rrule: string, source: CalendarSource, ctx: SyncContext): Promise<void> {
    // All-day routines skip the time/duration extraction — GCal emits `start.date` (YYYY-MM-DD)
    // with no time component, so `extractLocalTime` and the `diff('minute')` math would both yield
    // junk. Downstream item generation reads `template.allDay` to switch to the all-day shape.
    // The existing `buildCalendarItem` guard (`throw 'all-day not yet wired here'`) still trips
    // until Phase 8 — that's intentional, since this routine carrying `template = { allDay: true }`
    // is what signals which reader needs the all-day branch.
    const calendarItemTemplate = event.allDay ? { allDay: true as const } : buildTimedTemplate(event, source.config.timeZone ?? 'UTC');

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
        calendarItemTemplate,
        template: event.description != null ? { notes: htmlToMarkdown(event.description) } : {},
        ...(event.description != null ? { lastSyncedNotes: event.description } : {}),
        createdTs,
        updatedTs: ctx.now,
    };

    await routinesDAO.insertOne(routine);
    ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'routine', entityId: routineId, snapshot: routine, opType: 'create', now: ctx.now }));

    // Generate the tail's calendar items here. updateRoutineFromGCal regenerates items on schedule
    // change (line ~1048) but a brand-new routine — most importantly the tail of a "this and following"
    // split — never goes through that path. Without this, the tail arrives via sync as a routine with
    // zero items, while the parent's future items have been (correctly) trashed past UNTIL.
    const itemOps = await regenerateFutureRoutineItems(routine, ctx.userId, ctx.now, source.config.timeZone ?? 'UTC');
    ctx.ops.push(...itemOps);
}

/** Extracts the {timeOfDay, duration} pair for a timed routine template. Pulled out of
 * `createRoutineFromGCal` so the all-day branch reads as a clean ternary. */
function buildTimedTemplate(event: GCalEvent, timeZone: string): { timeOfDay: string; duration: number } {
    const timeOfDay = extractLocalTime(event.timeStart, timeZone);
    const duration = dayjs(event.timeEnd).diff(dayjs(event.timeStart), 'minute');
    return { timeOfDay, duration };
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
    const newlyGainsUntil = structurallyNewer && !existing.rrule.includes('UNTIL=') && rrule.includes('UNTIL=');

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
                  // Mirror client-side splitRoutine: capping the parent pauses it so the UI
                  // reflects that the segment is historical. Without this, a capped-in-the-past
                  // routine shows as "Active" even though it no longer generates instances.
                  ...(newlyGainsUntil ? { active: false } : {}),
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
    if (newlyGainsUntil) {
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

    // Structural changes from GCal master need to reach existing items — GCal expands only a
    // near-term instance window when fetching exceptions, so relying on `syncRoutineExceptions`
    // alone leaves far-future items stuck on the old schedule/title.
    if (structurallyNewer) {
        await propagateMasterScheduleChanges(existing, updated, source, ctx);
    }
}

/**
 * Detects what changed between the pre- and post-update routine snapshots and pushes those
 * changes to the generated items:
 *  - rrule / timeOfDay / duration change → delete future items and regenerate on the new schedule
 *  - title-only change → rename future items in place (preserves IDs and per-instance overrides)
 */
async function propagateMasterScheduleChanges(previous: RoutineInterface, next: RoutineInterface, source: CalendarSource, ctx: SyncContext): Promise<void> {
    const scheduleChanged =
        previous.rrule !== next.rrule ||
        previous.calendarItemTemplate?.timeOfDay !== next.calendarItemTemplate?.timeOfDay ||
        previous.calendarItemTemplate?.duration !== next.calendarItemTemplate?.duration;

    if (scheduleChanged) {
        const itemOps = await regenerateFutureRoutineItems(next, ctx.userId, ctx.now, source.config.timeZone ?? 'UTC');
        ctx.ops.push(...itemOps);
        return;
    }

    if (previous.title !== next.title) {
        const itemOps = await propagateRoutineTitleToItems(next, ctx.userId, ctx.now);
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

/**
 * Subset of `GCalEvent` consumed by the inbound upsert/create/update path. Carries the GCal-owned
 * metadata fields (organizer/creator/attendees/responseStatus/eventType) and the `allDay` flag so
 * inbound parsing output can flow through unchanged. Kept as a structural-subset alias rather than
 * `GCalEvent` directly so the import-callsites (which already narrow `status: string`) stay valid.
 */
export type CalendarEvent = {
    id: string;
    title: string;
    timeStart: string;
    timeEnd: string;
    updated: string;
    status: string;
    description?: string;
    allDay?: boolean;
    organizer?: GCalPerson;
    creator?: GCalPerson;
    attendees?: GCalAttendee[];
    responseStatus?: GCalResponseStatus;
    eventType?: GCalEventType;
};

/**
 * Builds the GCal-owned slice of a calendar item from an inbound event. Returns the keys present
 * on `event` so the caller can spread the result; missing keys are explicitly cleared via
 * `clearOmittedGCalOwnedFields` on the merge path so a stale local value can't survive when GCal
 * stops emitting the field (e.g. last attendee removed).
 */
function pickGCalOwnedFields(event: CalendarEvent): Partial<Pick<ItemInterface, (typeof GCAL_OWNED_ITEM_KEYS)[number]>> {
    return {
        ...(event.organizer !== undefined ? { organizer: event.organizer } : {}),
        ...(event.creator !== undefined ? { creator: event.creator } : {}),
        ...(event.attendees !== undefined ? { attendees: event.attendees } : {}),
        ...(event.responseStatus !== undefined ? { responseStatus: event.responseStatus } : {}),
        ...(event.eventType !== undefined ? { eventType: event.eventType } : {}),
    };
}

/**
 * Field-level merge guard: `itemsDAO.replaceById` is a full-doc replace, so spreading
 * `{ ...existing, organizer: undefined }` would silently keep `existing.organizer`. After the merge
 * computes the next item, any GCal-owned key that isn't present on the inbound event must be
 * explicitly removed from the merged document — otherwise a stale local value (e.g. attendees from
 * a prior sync) survives even though GCal no longer reports it. Chose the explicit-delete strategy
 * over `$set/$unset` to keep the single `replaceById` write path uniform across all inbound branches.
 */
function clearOmittedGCalOwnedFields(merged: ItemInterface, event: CalendarEvent): ItemInterface {
    const next: ItemInterface = { ...merged };
    for (const key of GCAL_OWNED_ITEM_KEYS) {
        if (event[key] === undefined) {
            delete next[key];
        }
    }
    return next;
}

/**
 * True iff the inbound event reports a different value (including absent-vs-present) for any
 * GCal-owned key compared to the local item. Used to bypass the structural-newer early-exit so an
 * older payload can still propagate authoritative attendee/organizer/etc. changes.
 *
 * Deep-equality via JSON.stringify is fine here: the inbound parser sorts attendees by email and
 * the GCalPerson/GCalAttendee shapes are flat, deterministic objects.
 */
function hasGCalOwnedDelta(existing: ItemInterface, event: CalendarEvent): boolean {
    return GCAL_OWNED_ITEM_KEYS.some((key) => JSON.stringify(existing[key]) !== JSON.stringify(event[key]));
}

/**
 * Strong-key lookup: by `calendarEventId` only. Used for echo/cancelled/past-event branches that
 * must operate on a known-linked item. Naked-orphan relink is intentionally NOT done here —
 * relinking only makes sense for live future-confirmed events.
 */
async function findCalendarItemByEventId(event: CalendarEvent, ctx: SyncContext): Promise<ItemInterface | undefined> {
    const [byEventId] = await itemsDAO.findArray({ user: ctx.userId, calendarEventId: event.id });
    return byEventId;
}

/**
 * Strong-key restore: an item whose link fields were renamed to `lastKnown*` on disconnect-with-keep
 * gets atomically restored when the matching GCal event is re-imported. Conditional on
 * `lastKnownCalendarEventId` still being set (TOCTOU-safe — a concurrent restore wins, the loser
 * returns undefined and the caller falls through to title+time fallback or create).
 */
async function tryRestoreFromLastKnownEventId(event: CalendarEvent, source: CalendarSource, ctx: SyncContext): Promise<ItemInterface | undefined> {
    const [candidate] = await itemsDAO.findArray({ user: ctx.userId, lastKnownCalendarEventId: event.id });
    if (!candidate?._id) {
        return undefined;
    }
    const itemId = candidate._id;
    const result = await itemsDAO.updateOne(
        { _id: itemId, user: ctx.userId, lastKnownCalendarEventId: event.id },
        {
            $set: {
                calendarEventId: event.id,
                calendarIntegrationId: source.integration._id,
                calendarSyncConfigId: source.config._id,
                updatedTs: ctx.now,
            },
            $unset: { lastKnownCalendarEventId: '', lastKnownCalendarIntegrationId: '', lastKnownCalendarSyncConfigId: '' },
        },
    );
    if (result.matchedCount === 0) {
        return undefined;
    }
    const restored = await itemsDAO.findByOwnerAndId(itemId, ctx.userId);
    if (!restored) {
        return undefined;
    }
    ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'item', entityId: itemId, snapshot: restored, opType: 'update', now: ctx.now }));
    console.log(`[gcal-sync] restored item from lastKnownCalendarEventId | itemId=${itemId} eventId=${event.id} title="${event.title}"`);
    return restored;
}

/**
 * Looks for a "naked" candidate — an item previously linked but unlinked by a `keepLinkedEntities`
 * disconnect (or `removeLinkedEntities` for done items, which also unlink) — and atomically relinks
 * it to the inbound event. Returns the relinked item, or `undefined` if no candidate matches OR if
 * a concurrent webhook won the race to claim the candidate first.
 *
 * Match dimensions:
 *  - same user, status in {'calendar', 'done'}, no link fields set
 *  - same time window (±1 minute on each bound, to absorb DST roundtrips and offset normalization)
 *  - title equality OR (`done` candidate whose stored title matches the GCal title with the "✓ "
 *    marker stripped — the app stores done titles unprefixed but pushes them prefixed to GCal).
 *
 * Ordering: this is called only from the live future-confirmed-event branch of `upsertCalendarItem`,
 * AFTER cancelled/past/echo guards. That keeps the side-effecting relink op out of paths where the
 * inbound event will not result in a live local item.
 */
async function tryRelinkNakedCalendarItem(event: CalendarEvent, source: CalendarSource, ctx: SyncContext): Promise<ItemInterface | undefined> {
    // Done items store unprefixed titles; the app prefixes "✓ " only on the GCal push. So the same
    // GCal event title may correspond to either an unprefixed done item or a prefixed open item.
    const titleAlternatives = Array.from(new Set([event.title, stripDoneMarker(event.title)]));
    // Time match is done in JS (after the Mongo query) on instant equality with a 1-minute
    // tolerance — string equality on ISO timestamps would miss legitimate roundtrip variants
    // (DST shifts, +03:00 vs Z normalizations, etc.) that still represent the same instant.
    const candidates = await itemsDAO.findArray({
        user: ctx.userId,
        status: { $in: ['calendar', 'done'] },
        calendarEventId: { $exists: false },
        calendarIntegrationId: { $exists: false },
        title: { $in: titleAlternatives },
    });
    const naked = candidates.filter((item) => instantsWithin(item.timeStart, event.timeStart, 1) && instantsWithin(item.timeEnd, event.timeEnd, 1));
    if (!hasAtLeastOne(naked)) {
        return undefined;
    }
    return await relinkBestNakedCandidate(naked, event, source, ctx);
}

/** True when two ISO timestamps refer to instants within `toleranceMinutes` of each other. */
function instantsWithin(a: string | undefined, b: string, toleranceMinutes: number): boolean {
    if (!a) {
        return false;
    }
    return Math.abs(dayjs(a).diff(dayjs(b), 'minute')) <= toleranceMinutes;
}

/**
 * Picks the most recently updated naked candidate and atomically relinks it. Conditional update on
 * `calendarEventId: { $exists: false }` means a concurrent webhook that already claimed the same
 * candidate causes our update to match zero docs — the loser falls through, and `upsertCalendarItem`
 * will create a fresh item on the next iteration. Better duplicate than silent overwrite.
 */
async function relinkBestNakedCandidate(
    candidates: NonEmptyArray<ItemInterface>,
    event: CalendarEvent,
    source: CalendarSource,
    ctx: SyncContext,
): Promise<ItemInterface | undefined> {
    const best = pickMostRecentlyUpdated(candidates);
    const itemId = best._id;
    if (!itemId) {
        return undefined;
    }
    const result = await itemsDAO.updateOne(
        { _id: itemId, user: ctx.userId, calendarEventId: { $exists: false }, calendarIntegrationId: { $exists: false } },
        {
            $set: {
                calendarEventId: event.id,
                calendarIntegrationId: source.integration._id,
                calendarSyncConfigId: source.config._id,
                updatedTs: ctx.now,
            },
        },
    );
    if (result.matchedCount === 0) {
        return undefined;
    }
    const relinked = await itemsDAO.findOne({ _id: itemId, user: ctx.userId });
    if (!relinked) {
        return undefined;
    }
    ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'item', entityId: itemId, snapshot: relinked, opType: 'update', now: ctx.now }));
    console.log(`[gcal-sync] relinked naked item to GCal event | itemId=${itemId} eventId=${event.id} title="${event.title}"`);
    return relinked;
}

/** Returns the entry with the largest `updatedTs` (lexicographic ISO compare). NonEmptyArray-typed so the empty-reduce throw can never fire. */
function pickMostRecentlyUpdated<T extends { updatedTs?: string }>(items: NonEmptyArray<T>): T {
    return items.reduce((acc, cur) => ((cur.updatedTs ?? '') > (acc.updatedTs ?? '') ? cur : acc));
}

export async function upsertCalendarItem(event: CalendarEvent, source: CalendarSource, ctx: SyncContext): Promise<void> {
    let existing = await findCalendarItemByEventId(event, ctx);

    console.log(
        `[debug-gcal-sync][server] upsertCalendarItem | eventId=${event.id} title="${event.title}" status=${event.status} eventUpdated=${event.updated} existing=${!!existing} existingUpdatedTs=${existing?.updatedTs ?? 'n/a'} existingStatus=${existing?.status ?? 'n/a'} lastPushedToGCalTs=${existing?.lastPushedToGCalTs ?? 'n/a'}`,
    );

    // Echo detection: if the item was recently pushed to GCal by the app, skip re-importing
    // the same change back. The 5-second window catches the typical push→webhook roundtrip.
    if (existing?.lastPushedToGCalTs && isOwnEcho(existing.lastPushedToGCalTs, event.updated)) {
        console.log(`[debug-gcal-sync][server] upsertCalendarItem skipped — own echo | eventId=${event.id}`);
        return;
    }

    if (event.status === 'cancelled') {
        // Skip the strong-key restore for cancelled events: there's nothing to restore TO (the
        // event is gone). Restoring then trashing would emit a redundant op + status flap.
        // Stamp `cancelledByGCal: true` so the trash view can surface a "Cancelled in Calendar"
        // badge — distinguishes a GCal-driven cancellation from a user-initiated trash.
        await trashItem(existing, ctx, { cancelledByGCal: true });
        return;
    }

    // Past-event handling: anything that ended before start-of-today (in the calendar's timezone)
    // is treated as past. New past events are ignored; an existing live `calendar` item moved to
    // before today is trashed (the user dragged it into the past, so it's no longer on the calendar).
    // Routine-managed items are preserved (the routine path owns their lifecycle).
    // Skip strong-key restore for past events for the same reason as cancelled — restoring an item
    // that we'd immediately trash via `applyPastEventToExisting` is a wasted op + flap.
    const cutoffIso = startOfTodayInTz(ctx.now, source.config.timeZone ?? 'UTC');
    if (event.timeStart && isPastEvent(event, cutoffIso)) {
        await applyPastEventToExisting(existing, event, source, ctx);
        return;
    }

    // Strong-key restore from the disconnect-with-keep marker. Runs AFTER the cancelled/past/echo
    // short-circuits so a marker-matching cancelled/past/own-echo event doesn't emit a redundant
    // restore op followed immediately by a trash/no-op.
    if (!existing) {
        existing = await tryRestoreFromLastKnownEventId(event, source, ctx);
    }

    // Revive: a future-confirmed event whose local item was trashed (typically by a prior
    // disconnect that bumped `updatedTs`) must be restored to `status: 'calendar'` regardless
    // of the structural-newer guard — local trash stamps are never authoritative against GCal
    // truth. Past-confirmed events have already short-circuited above.
    if (existing && existing.status === 'trash' && !existing.routineId) {
        await reviveTrashedCalendarItem(existing, event, source, ctx);
        return;
    }

    // Naked-orphan relink: only attempt for live future-confirmed events with no strong-key match.
    // Done above the `createNewCalendarItem` fallback so a previously-unlinked item (post-disconnect)
    // is reused instead of producing a duplicate.
    if (!existing) {
        existing = await tryRelinkNakedCalendarItem(event, source, ctx);
    }

    if (existing) {
        await updateExistingCalendarItem(existing, event, source, ctx);
    } else {
        await createNewCalendarItem(event, source, ctx);
    }
}

async function reviveTrashedCalendarItem(existing: ItemInterface, event: CalendarEvent, source: CalendarSource, ctx: SyncContext): Promise<void> {
    const itemId = existing._id;
    if (!itemId) {
        return;
    }
    // Done-stays-done invariant: a trashed item whose title still bears the "✓ " marker was
    // previously `done` locally. The current disconnect paths never trash a done item (see
    // `trashItemsForIntegration` and `unlinkItems`), so this branch should not fire in normal
    // operation — but if a future code path or manual mongo edit ever produces this state, we
    // preserve the done semantics instead of resurrecting the item as a live calendar entry.
    // Title is also the only persisted signal we have; `lastDoneTs` is not tracked.
    if (existing.title.startsWith(DONE_PREFIX) || (event.title.startsWith(DONE_PREFIX) && existing.title === stripDoneMarker(event.title))) {
        console.warn(`[gcal-sync] refusing to revive trashed item with done marker | itemId=${itemId} eventId=${event.id} title="${existing.title}"`);
        // Same GCal-owned merge as the live-revive path below — done-marker revive is rare but
        // must not leave stale attendees/organizer/etc. behind once they're first-class fields.
        const { cancelledByGCal: _cleared, ...withoutCancelledFlag } = existing;
        const merged: ItemInterface = {
            ...withoutCancelledFlag,
            status: 'done',
            title: stripDoneMarker(existing.title),
            calendarEventId: event.id,
            calendarIntegrationId: source.integration._id,
            calendarSyncConfigId: source.config._id,
            ...pickGCalOwnedFields(event),
            lastSyncedFromGCalTs: event.updated,
            updatedTs: ctx.now,
        };
        const restored = clearOmittedGCalOwnedFields(merged, event);
        await itemsDAO.replaceById(itemId, restored);
        ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'item', entityId: itemId, snapshot: restored, opType: 'update', now: ctx.now }));
        return;
    }
    // On revive, treat GCal's title verbatim (no `stripDoneMarker`) — the item is being restored
    // from trash, so any prior "done" semantics are irrelevant. For notes, pass the epoch as the
    // local anchor so the last-write-wins comparison in resolveInboundNotes always picks GCal
    // (the local trash-stamp `updatedTs` is presumed stale and never authoritative on revive).
    // Note: `dayjs('')` is `NaN` and would make GCal lose every comparison — must use a real timestamp.
    const notesUpdate = resolveInboundNotes(event.description, existing.lastSyncedNotes, event.updated, '1970-01-01T00:00:00.000Z');
    // Revive overwrites every structural + GCal-owned field from GCal verbatim — the local trashed
    // snapshot is presumed stale, so a prior `cancelledByGCal: true` (set when GCal first cancelled
    // the event) must be cleared so the revived item doesn't carry a phantom "Cancelled" badge.
    const { cancelledByGCal: _cleared, ...withoutCancelledFlag } = existing;
    const merged: ItemInterface = {
        ...withoutCancelledFlag,
        status: 'calendar',
        title: event.title,
        timeStart: event.timeStart,
        timeEnd: event.timeEnd,
        calendarSyncConfigId: source.config._id,
        ...(event.allDay ? { allDay: true } : {}),
        ...pickGCalOwnedFields(event),
        ...notesUpdate,
        lastSyncedFromGCalTs: event.updated,
        updatedTs: ctx.now,
    };
    // Strip stale GCal-owned values (e.g. attendees removed) — replaceById would otherwise preserve them.
    // Also clear `allDay` if GCal no longer marks the event as all-day.
    const updated = clearAllDayIfAbsent(clearOmittedGCalOwnedFields(merged, event), event);
    await itemsDAO.replaceById(itemId, updated);
    ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'item', entityId: itemId, snapshot: updated, opType: 'update', now: ctx.now }));
}

/** Symmetric to `clearOmittedGCalOwnedFields` for the `allDay` flag — replaceById would otherwise
 * keep a stale `true` after GCal converts a previously-all-day event to a timed one. */
function clearAllDayIfAbsent(merged: ItemInterface, event: CalendarEvent): ItemInterface {
    if (event.allDay) {
        return merged;
    }
    const { allDay: _stale, ...rest } = merged;
    return rest;
}

/**
 * Resolves a past event's effect on the existing local item:
 * - no local item: nothing to do
 * - routine-managed: skip (routine path owns lifecycle)
 * - live `calendar` item: trash (user moved it into the past)
 * - other statuses (user reclassified to nextAction/done): preserve edit semantics
 */
async function applyPastEventToExisting(existing: ItemInterface | undefined, event: CalendarEvent, source: CalendarSource, ctx: SyncContext): Promise<void> {
    if (!existing || existing.routineId || existing.status === 'trash') {
        return;
    }
    if (existing.status === 'calendar') {
        await trashItem(existing, ctx);
        return;
    }
    await updateExistingCalendarItem(existing, event, source, ctx);
}

/**
 * Idempotently trashes the given item. No-ops on:
 * - missing item, routine-managed item, or already-trashed item.
 * Used by both the cancelled-event path and the moved-to-past path. When `cancelledByGCal` is true
 * the item is stamped so the trash view can surface a "Cancelled in Calendar" badge; the past-event
 * path leaves it unset so a user-driven drag-into-past doesn't masquerade as a GCal cancellation.
 */
async function trashItem(existing: ItemInterface | undefined, ctx: SyncContext, options: { cancelledByGCal?: boolean } = {}): Promise<void> {
    if (!existing || existing.routineId || existing.status === 'trash') {
        return;
    }
    const itemId = existing._id;
    if (!itemId) {
        return;
    }
    const setFields = {
        status: 'trash' as const,
        updatedTs: ctx.now,
        ...(options.cancelledByGCal ? { cancelledByGCal: true } : {}),
    };
    await itemsDAO.updateOne({ _id: itemId, user: ctx.userId }, { $set: setFields });
    const op = await recordOperation(ctx.userId, {
        entityType: 'item',
        entityId: itemId,
        snapshot: { ...existing, ...setFields },
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

    // Structural-newer guard compares against `lastSyncedFromGCalTs` (the GCal-side anchor of the
    // last applied payload), not `updatedTs` — local-only writes (e.g. trash-on-disconnect) bump
    // `updatedTs` and would otherwise lock GCal out of reasserting state.
    const structurallyNewer = event.updated > (existing.lastSyncedFromGCalTs ?? '');
    // GCal-owned fields are always overwritten even when the payload is structurally older — they
    // have no LWW gate (RSVP is the one local-write exception, routed through opType:'rsvp'). The
    // early-exit must therefore also fall through when any owned field differs, otherwise an older
    // payload with newer attendees/organizer/etc. would silently no-op the merge.
    const gcalOwnedChanged = hasGCalOwnedDelta(existing, event);
    if (!structurallyNewer && !notesUpdate && !gcalOwnedChanged) {
        console.log(
            `[debug-gcal-sync][server] updateExistingCalendarItem skipped — not newer | eventId=${event.id} eventUpdated=${event.updated} existingLastSyncedFromGCalTs=${existing.lastSyncedFromGCalTs ?? 'n/a'} structurallyNewer=${structurallyNewer} notesUpdate=${!!notesUpdate} gcalOwnedChanged=${gcalOwnedChanged}`,
        );
        return;
    }
    console.log(
        `[debug-gcal-sync][server] updateExistingCalendarItem applying | eventId=${event.id} structurallyNewer=${structurallyNewer} notesUpdate=${!!notesUpdate} gcalOwnedChanged=${gcalOwnedChanged}`,
    );

    // Sync layer owns the "✓ " done marker on GCal — strip it on inbound only when this item is
    // already done locally. For an open item, a user-typed "✓ " in GCal must be preserved verbatim.
    const incomingTitle = existing.status === 'done' ? stripDoneMarker(event.title) : event.title;

    // Field-level merge:
    //  - Structural fields (title/time/allDay) stay behind the `structurallyNewer` gate.
    //  - GCal-owned fields (organizer/creator/attendees/responseStatus/eventType) are ALWAYS
    //    overwritten — they're authoritative on the GCal side regardless of `event.updated`, and
    //    the only sanctioned local-write into that set (RSVP) routes through a dedicated op type.
    //  - `replaceById` is full-doc replace, so we wrap the merged object through
    //    `clearOmittedGCalOwnedFields` to drop stale values whenever GCal stops emitting a key
    //    (e.g. attendees emptied, eventType reset to default).
    const merged: ItemInterface = {
        ...existing,
        ...(structurallyNewer
            ? {
                  title: incomingTitle,
                  timeStart: event.timeStart,
                  timeEnd: event.timeEnd,
                  calendarSyncConfigId: source.config._id,
                  ...(event.allDay ? { allDay: true } : {}),
              }
            : {}),
        ...notesUpdate,
        ...pickGCalOwnedFields(event),
        // Only advance the anchor when this payload is structurally newer than the last one we
        // applied. A notes-only update against an older `event.updated` (out-of-order webhook
        // delivery) must not regress the anchor — that would let an even-older subsequent
        // payload overwrite structural fields by passing the guard again.
        ...(structurallyNewer ? { lastSyncedFromGCalTs: event.updated } : {}),
        updatedTs: ctx.now,
    };
    const withGCalOwnedCleared = clearOmittedGCalOwnedFields(merged, event);
    // Only re-evaluate `allDay` against the inbound event when structural fields are being
    // applied — a non-structural inbound (notes-only / older payload) must not erase the local
    // `allDay` flag, since GCal didn't authorize a structural change.
    const updated = structurallyNewer ? clearAllDayIfAbsent(withGCalOwnedCleared, event) : withGCalOwnedCleared;
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
        // Forward all-day flag + GCal-owned meeting metadata so the new item carries the same
        // surface as a subsequent inbound update. On create no `clearOmitted*` is needed —
        // there's no stale local state to wipe.
        ...(event.allDay ? { allDay: true } : {}),
        ...pickGCalOwnedFields(event),
        lastSyncedFromGCalTs: event.updated,
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
export async function applyExceptionToItems(routine: RoutineInterface, ex: GCalException, ctx: SyncContext): Promise<void> {
    if (!ISO_DATE_RE.test(ex.originalDate)) {
        return;
    }
    const target = await resolveExceptionTarget(routine, ex, ctx.userId);

    if (ex.type === 'deleted') {
        // No create-on-miss for deletes — there's nothing to delete if no item matches.
        await updateItemsAndRecordOps(ctx, { filter: target.filter, setFields: { status: 'trash', updatedTs: ctx.now } });
        return;
    }

    if (ex.type === 'modified') {
        const sharedFields = {
            updatedTs: ctx.now,
            ...(ex.newTimeStart ? { timeStart: ex.newTimeStart } : {}),
            ...(ex.newTimeEnd ? { timeEnd: ex.newTimeEnd } : {}),
            // ex.notes is raw HTML from GCal — convert to markdown for storage, keep HTML as lastSyncedNotes
            ...(ex.notes !== undefined ? { notes: htmlToMarkdown(ex.notes), lastSyncedNotes: ex.notes } : {}),
        };
        if (hasAtLeastOne(target.matches)) {
            await applyModifiedExceptionToMatches(target.matches, ex, sharedFields, ctx);
            return;
        }
        // Create-on-miss closes the gap where applyExceptionToItems silently dropped moves —
        // typically a second move of the same instance, where the prior move's exception had already
        // shifted the item's `timeStart` so the date-keyed lookup misses.
        await createItemForOrphanedException(routine, ex, ctx);
    }
}

interface ExceptionTarget {
    /** Filter that produced `matches` — kept around for `deleted` exceptions which write via filter. */
    filter: Record<string, unknown>;
    matches: ItemInterface[];
}

/**
 * Two-tier lookup for the item(s) an inbound exception should target:
 *
 *  1. Preferred — match by `calendarInstanceEventId`. Works even after a prior exception has
 *     shifted the item's `timeStart`, because the instance id is anchored to the *original*
 *     occurrence date and never changes for the life of the row.
 *  2. Fallback (transitional) — match by `routineId + originalDate` for routine-generated rows
 *     that pre-date the `calendarInstanceEventId` rollout. Remove once the backfill is fully
 *     applied across all production users.
 *
 * Pre-fetches the matching rows so the apply path doesn't re-query (avoids a TOCTOU window where
 * a concurrent delete between two reads would make the apply silently no-op).
 */
async function resolveExceptionTarget(routine: RoutineInterface, ex: GCalException, userId: string): Promise<ExceptionTarget> {
    if (ex.googleEventId) {
        const preferred = { user: userId, calendarInstanceEventId: ex.googleEventId } as const;
        const hits = await itemsDAO.findArray(preferred);
        if (hits.length > 0) {
            return { filter: preferred, matches: hits };
        }
    }
    // Use a date-range query rather than $regex to avoid regex injection from GCal data.
    // Scope to status:'calendar' so we never reanimate a `done` or re-trash a `trash` row that
    // happens to share the originalDate with this routine.
    const nextDay = dayjs(ex.originalDate).add(1, 'day').format('YYYY-MM-DD');
    const fallbackFilter = { user: userId, routineId: routine._id, status: 'calendar', timeStart: { $gte: ex.originalDate, $lt: nextDay } } as const;
    return { filter: fallbackFilter, matches: await itemsDAO.findArray(fallbackFilter) };
}

/**
 * Applies a `modified` exception to the already-resolved match set. Writes use an `updateOne`
 * conditional on the row's `updatedTs` matching what we resolved — protects against a concurrent
 * `/sync/push` edit landing between `resolveExceptionTarget` and apply that we would otherwise
 * silently clobber. On match-zero we skip; the next inbound sync re-reads and resolves naturally.
 *
 * NonEmptyArray guarantees at least one match. The previous re-narrowing via `withId.filter` is
 * dead under that invariant — `resolveExceptionTarget` always pre-filters to rows with `_id` set
 * (Mongo populates `_id` on insert) so we go straight to per-item updates.
 */
async function applyModifiedExceptionToMatches(
    matches: NonEmptyArray<ItemInterface>,
    ex: GCalException,
    sharedFields: Record<string, unknown>,
    ctx: SyncContext,
): Promise<void> {
    await Promise.all(matches.map((item) => applyModifiedExceptionToOne(item, ex, sharedFields, ctx)));
}

async function applyModifiedExceptionToOne(item: ItemInterface, ex: GCalException, sharedFields: Record<string, unknown>, ctx: SyncContext): Promise<void> {
    const itemId = item._id;
    if (!itemId) {
        return;
    }
    // The sync layer owns the "✓ " done marker on GCal — strip it on inbound only when the local
    // item is already done (e.g. our own pushback echo). Otherwise a routine-instance round-trip
    // would corrupt the stored title with the marker we ourselves applied.
    const title = ex.title !== undefined && item.status === 'done' ? stripDoneMarker(ex.title) : (ex.title ?? item.title);
    const setFields = { ...sharedFields, title } as Record<string, unknown>;
    // Conditional on `updatedTs` — a concurrent /sync/push edit landing between resolve and apply
    // would change `updatedTs`; matchedCount === 0 means we lost the race and must not clobber.
    const result = await itemsDAO.updateOne({ _id: itemId, user: ctx.userId, updatedTs: item.updatedTs } as never, { $set: setFields });
    if (result.matchedCount === 0) {
        console.log(`[gcal-sync] applyModifiedExceptionToOne: skipped due to concurrent updatedTs bump | itemId=${itemId}`);
        return;
    }
    const updated: ItemInterface = { ...item, ...setFields } as ItemInterface;
    ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'item', entityId: itemId, snapshot: updated, opType: 'update', now: ctx.now }));
}

/**
 * Inserts a fresh calendar item for a `modified` exception that matched zero existing rows. The
 * derived `timeStart`/`timeEnd` fall back to the routine's regular schedule when GCal didn't
 * include explicit move times (a pure title/notes edit on a missing item — uncommon but possible).
 *
 * Race protection: two concurrent inbound paths (manual `/calendar/integrations/:id/sync` racing a
 * `webhooks/google` delivery) can both see `resolveExceptionTarget` miss and both reach this code.
 * The `(user, calendarInstanceEventId)` unique partial index forces the loser's `insertOne` to
 * raise E11000 — we re-resolve and apply onto the race winner's row so both callers converge on
 * one item. Without this, you'd see two duplicate items for one exception.
 */
async function createItemForOrphanedException(routine: RoutineInterface, ex: GCalException, ctx: SyncContext): Promise<void> {
    const derived = deriveExceptionItemTimes(routine, ex);
    if (!derived) {
        // No schedule data to fall back to — skip rather than insert a malformed row.
        console.warn(`[gcal-sync] applyExceptionToItems: cannot derive timeStart for orphan exception | routineId=${routine._id} date=${ex.originalDate}`);
        return;
    }
    const itemId = randomUUID();
    // Mirrors the `buildCalendarItem` shape for parity: orphan-create rows carry the routine's
    // calendarIntegrationId + calendarSyncConfigId so UI/audit queries that filter by integration
    // see all routine-generated items uniformly, regardless of which path created them.
    const item: ItemInterface = {
        _id: itemId,
        user: ctx.userId,
        routineId: routine._id,
        status: 'calendar',
        title: ex.title ?? routine.title,
        timeStart: derived.timeStart,
        timeEnd: derived.timeEnd,
        ...(routine.calendarIntegrationId ? { calendarIntegrationId: routine.calendarIntegrationId } : {}),
        ...(routine.calendarSyncConfigId ? { calendarSyncConfigId: routine.calendarSyncConfigId } : {}),
        ...(ex.googleEventId ? { calendarInstanceEventId: ex.googleEventId } : {}),
        ...(ex.notes !== undefined ? { notes: htmlToMarkdown(ex.notes), lastSyncedNotes: ex.notes } : {}),
        createdTs: ctx.now,
        updatedTs: ctx.now,
    };
    try {
        await itemsDAO.insertOne(item);
    } catch (err) {
        if (isDuplicateKeyError(err)) {
            // The race winner already inserted a row with this `calendarInstanceEventId`. Re-resolve
            // — `target.matches` will now find the winner — and fall through to the standard apply.
            await applyExceptionAfterDuplicate(routine, ex, ctx);
            return;
        }
        throw err;
    }
    ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'item', entityId: itemId, snapshot: item, opType: 'create', now: ctx.now }));
    console.log(
        `[gcal-sync] applyExceptionToItems: created orphan-exception item | routineId=${routine._id} itemId=${itemId} googleEventId=${ex.googleEventId ?? 'n/a'}`,
    );
}

function isDuplicateKeyError(err: unknown): boolean {
    return err instanceof Error && 'code' in err && (err as { code: number }).code === 11000;
}

/**
 * Race-loser fallthrough: re-resolve the exception target (the race winner's row is now visible)
 * and apply the exception's `sharedFields` onto it via the normal modified-exception path. Keeps
 * the post-write state of the row consistent regardless of which caller actually inserted it.
 */
async function applyExceptionAfterDuplicate(routine: RoutineInterface, ex: GCalException, ctx: SyncContext): Promise<void> {
    const target = await resolveExceptionTarget(routine, ex, ctx.userId);
    if (!hasAtLeastOne(target.matches)) {
        // Index says a row exists with our instance id, but resolve missed — log + bail rather than retry forever.
        console.warn(`[gcal-sync] applyExceptionAfterDuplicate: index hit but re-resolve missed | routineId=${routine._id} eventId=${ex.googleEventId}`);
        return;
    }
    const sharedFields = {
        updatedTs: ctx.now,
        ...(ex.newTimeStart ? { timeStart: ex.newTimeStart } : {}),
        ...(ex.newTimeEnd ? { timeEnd: ex.newTimeEnd } : {}),
        ...(ex.notes !== undefined ? { notes: htmlToMarkdown(ex.notes), lastSyncedNotes: ex.notes } : {}),
    };
    await applyModifiedExceptionToMatches(target.matches, ex, sharedFields, ctx);
}

/** Picks `timeStart`/`timeEnd` for an orphan-create from the exception's move times, falling back to the routine's regular schedule. */
function deriveExceptionItemTimes(routine: RoutineInterface, ex: GCalException): { timeStart: string; timeEnd: string } | undefined {
    if (ex.newTimeStart && ex.newTimeEnd) {
        return { timeStart: ex.newTimeStart, timeEnd: ex.newTimeEnd };
    }
    const template = routine.calendarItemTemplate;
    if (!template) {
        return undefined;
    }
    const { timeOfDay, duration } = template;
    if (timeOfDay === undefined || duration === undefined) {
        // all-day routine — orphan-create derivation is handled by the all-day branch (Phase 8); skip here.
        return undefined;
    }
    const timeStart = `${ex.originalDate}T${timeOfDay}:00`;
    const timeEnd = dayjs(timeStart).add(duration, 'minute').format('YYYY-MM-DDTHH:mm:ss');
    return { timeStart, timeEnd };
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

// ── RSVP endpoint (online fast-path) ─────────────────────────────────────────
//
// Online clients hit this synchronously so the optimistic UI can commit only after GCal accepts
// the change. Offline clients queue an `opType: 'rsvp'` op locally and replay through the standard
// sync flush on reconnect — the replay path (added in Phase 4) calls into the same helper
// (`applyRsvpToItem`) so the on-wire behavior is identical.

/** Google Calendar scopes that authorize attendee writes (RSVP is an attendee mutation). */
const CALENDAR_WRITE_SCOPES = ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events'] as const;

/** Allowed `responseStatus` values for the RSVP body — `needsAction` is the absence of a response, not a request. */
const RSVP_RESPONSE_STATUSES = ['accepted', 'declined', 'tentative'] as const;
type RsvpResponseStatus = (typeof RSVP_RESPONSE_STATUSES)[number];

/** Type guard for the RSVP body. Strict: we reject 400 when the shape doesn't match. */
function parseRsvpBody(raw: unknown): { responseStatus: RsvpResponseStatus } | null {
    if (typeof raw !== 'object' || raw === null) {
        return null;
    }
    const status = (raw as { responseStatus?: unknown }).responseStatus;
    if (typeof status !== 'string' || !(RSVP_RESPONSE_STATUSES as readonly string[]).includes(status)) {
        return null;
    }
    return { responseStatus: status as RsvpResponseStatus };
}

/**
 * Returns true when the integration's grantedScopes allow attendee writes. Permissive when
 * grantedScopes is undefined (legacy rows from before scope persistence) — those users authorized
 * the full `auth/calendar` scope in practice.
 */
function hasCalendarWriteScope(integration: CalendarIntegrationInterface): boolean {
    if (!integration.grantedScopes) {
        return true;
    }
    return integration.grantedScopes.some((s) => (CALENDAR_WRITE_SCOPES as readonly string[]).includes(s));
}

/** Builds the OAuth re-consent URL surfaced when `grantedScopes` lacks calendar write. */
function buildReconsentUrl(loginHint: string | undefined): string {
    const apiBase = process.env.BETTER_AUTH_URL ?? 'http://localhost:4000';
    const params = new URLSearchParams({ intent: 'rsvp' });
    if (loginHint) {
        params.set('login_hint', loginHint);
    }
    return `${apiBase}/calendar/auth/google?${params.toString()}`;
}

calendarRoutes.post('/items/:itemId/rsvp', authenticateRequest, async (c) => {
    const userId = c.get('session').user.id;
    const itemId = c.req.param('itemId');

    const body = parseRsvpBody(await c.req.json().catch(() => null));
    if (!body) {
        return c.json({ error: 'responseStatus must be one of: accepted, declined, tentative' }, 400);
    }

    const item = await itemsDAO.findByOwnerAndId(itemId, userId);
    if (!item) {
        return c.json({ error: 'Item not found' }, 404);
    }
    if (item.status !== 'calendar' || !item.calendarEventId || !item.calendarIntegrationId) {
        return c.json({ error: 'Item is not a linked calendar event' }, 400);
    }

    const integration = await calendarIntegrationsDAO.findByOwnerAndIdDecrypted(item.calendarIntegrationId, userId);
    if (!integration) {
        return c.json({ error: 'Calendar integration not found' }, 404);
    }
    if (!hasCalendarWriteScope(integration)) {
        // Pass the active session email as login_hint so the popup pre-selects the right Google
        // account. The OAuth start endpoint doesn't currently honor `intent`; we surface it for the
        // UI's bookkeeping (post-popup it can confirm the reconnect was actually for RSVP).
        const reconsentUrl = buildReconsentUrl(c.get('session').user.email);
        return c.json({ error: 'scope_missing', reconsentUrl }, 403);
    }

    const config = await resolveSyncConfigForItem(item, integration._id, userId);
    if (!config) {
        return c.json({ error: 'No sync config found for this calendar' }, 404);
    }

    const provider = buildProvider(integration, userId);
    const myEmail = await provider.getMyEmail();
    const nextAttendees = applyRsvpToAttendees(item.attendees ?? [], myEmail, body.responseStatus);

    // Stamp `lastPushedToGCalTs` BEFORE the GCal PATCH so the echo guard at line 88 anchors on
    // the moment we initiated the push. If we stamped after the await, slow PATCH/Pub-Sub
    // latency could push the diff past ECHO_WINDOW_SECONDS and the webhook-arrived inbound
    // would be mis-classified as an external change and re-applied to the local item.
    const now = dayjs().toISOString();
    try {
        // sendUpdates:'all' so the organizer sees the response change. Per plan, RSVPs always notify.
        // patchEventAttendees replaces the entire attendees array on GCal — if the organizer added a
        // new attendee between our last pull and this PATCH, we will inadvertently drop them. The plan
        // accepts this race for v1; the next inbound pull from GCal restores the missing attendee
        // because GCal-owned fields are always overwritten regardless of event.updated ordering.
        await provider.patchEventAttendees(config.calendarId, item.calendarEventId, nextAttendees, { sendUpdates: 'all' });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return c.json({ error: 'rsvp_push_failed', message }, 500);
    }

    const updated: ItemInterface = {
        ...item,
        attendees: nextAttendees,
        responseStatus: body.responseStatus,
        lastPushedToGCalTs: now,
        updatedTs: now,
    };
    await itemsDAO.replaceById(itemId, updated);

    await recordOperation(userId, {
        entityType: 'item',
        entityId: itemId,
        snapshot: null,
        opType: 'rsvp',
        rsvp: {
            itemId,
            calendarEventId: item.calendarEventId,
            calendarIntegrationId: integration._id,
            responseStatus: body.responseStatus,
        },
        now,
    });

    return c.json(updated);
});

// ── Webhook watch management ─────────────────────────────────────────────────

/** Sets up a Google push notification channel for the given sync config. Stores webhook fields on success. */
async function setupWatch(config: CalendarSyncConfigInterface, provider: GoogleCalendarProvider, integrationId: string): Promise<void> {
    // Webhook feature is opt-in: no-op when CALENDAR_WEBHOOK_URL is not configured.
    const webhookUrl = process.env.CALENDAR_WEBHOOK_URL;
    if (!webhookUrl) {
        return;
    }
    const channelId = randomUUID();
    const { resourceId, expiration } = await withAuthFailureHandling(integrationId, () => provider.watchEvents(config.calendarId, webhookUrl, channelId));
    await calendarSyncConfigsDAO.upsertWebhookFields(config._id, channelId, resourceId, expiration);
}

/** Stops the existing push notification channel for the given sync config. Clears webhook fields regardless of whether the stop call succeeds. */
async function teardownWatch(config: CalendarSyncConfigInterface, provider: GoogleCalendarProvider, integrationId: string): Promise<void> {
    const channelId = config.webhookChannelId;
    const resourceId = config.webhookResourceId;
    if (channelId && resourceId) {
        // Best-effort stop — the channel may have already expired or been invalidated.
        await withAuthFailureHandling(integrationId, () => provider.stopWatch(channelId, resourceId)).catch(() => {});
    }
    await calendarSyncConfigsDAO.clearWebhookFields(config._id);
}

/** Re-registers the webhook channel if it is expired or expiring within 1 day. */
async function renewWebhookIfExpired(config: CalendarSyncConfigInterface, provider: GoogleCalendarProvider, integrationId: string): Promise<void> {
    if (!process.env.CALENDAR_WEBHOOK_URL) {
        return;
    }

    const needsRenewal = !config.webhookExpiry || dayjs(config.webhookExpiry).isBefore(dayjs().add(1, 'day'));
    if (!needsRenewal) {
        return;
    }

    if (config.webhookChannelId) {
        await teardownWatch(config, provider, integrationId);
    }
    await setupWatch(config, provider, integrationId);
    console.log(`[calendar-webhook] renewed watch for config ${config._id}`);
}

export { buildProvider, renewWebhookIfExpired };

// ── Webhook receiver ─────────────────────────────────────────────────────────

// Coalesce concurrent webhook deliveries per channel. Google can fire multiple notifications
// for back-to-back edits, and Cloud Run can deliver them faster than syncSingleCalendar finishes.
// State per channel: 'idle' = no sync in flight, 'running' = a sync is running, 'queued' =
// a sync is running and another delivery arrived (the running one will re-run when it finishes).
type WebhookState = 'running' | 'queued';
const channelStates = new Map<string, WebhookState>();

/** Returns true if a sync should start now. Returns false if one is already running (which marks 'queued' so it re-runs after). */
function tryStartWebhookSync(channelId: string): boolean {
    const state = channelStates.get(channelId);
    if (state === 'running' || state === 'queued') {
        channelStates.set(channelId, 'queued');
        return false;
    }
    channelStates.set(channelId, 'running');
    return true;
}

/** Called when a sync finishes. Returns true if another run is queued. */
function finishWebhookSync(channelId: string): boolean {
    const wasQueued = channelStates.get(channelId) === 'queued';
    if (wasQueued) {
        channelStates.set(channelId, 'running');
    } else {
        channelStates.delete(channelId);
    }
    return wasQueued;
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
        console.warn(`[debug-gcal-sync][server] webhook rejected — unknown channel | channelId=${channelId} resourceId=${resourceId} configFound=${!!config}`);
        return c.text('Unknown channel', 404);
    }

    // Respond immediately — Google expects a fast 200. Sync runs asynchronously.
    const response = c.text('OK', 200);

    console.log(
        `[gcal-webhook] received | channelId=${channelId} resourceId=${resourceId} state=${resourceState} configId=${config._id} calendarId=${config.calendarId}`,
    );

    const shouldStart = tryStartWebhookSync(channelId);
    if (!shouldStart) {
        console.log(`[gcal-webhook] coalesced — sync already running, queued re-run | channelId=${channelId}`);
    } else {
        // Fire-and-forget: run the sync in the background so we don't block the webhook response.
        runWebhookSyncLoop(config, channelId).catch((err) => {
            console.error(`[calendar-webhook] sync failed for config ${config._id}:`, err);
        });
    }

    return response;
});

/** Runs runWebhookSync, then re-runs while another delivery has been queued during the current run. */
async function runWebhookSyncLoop(config: CalendarSyncConfigInterface, channelId: string): Promise<void> {
    while (true) {
        await runWebhookSync(config);
        const hasQueuedRerun = finishWebhookSync(channelId);
        if (!hasQueuedRerun) {
            return;
        }
        console.log(`[gcal-webhook] running coalesced re-sync | channelId=${channelId}`);
    }
}

/** Runs an incremental sync for a single calendar config, triggered by a webhook notification. */
async function runWebhookSync(config: CalendarSyncConfigInterface): Promise<void> {
    console.log(`[gcal-webhook-sync] starting | configId=${config._id} calendarId=${config.calendarId}`);
    const integration = await calendarIntegrationsDAO.findByOwnerAndIdDecrypted(config.integrationId, config.user);
    if (!integration) {
        console.warn(`[calendar-webhook] integration ${config.integrationId} not found for config ${config._id} — skipping sync`);
        return;
    }
    // Skip suspended/revoked integrations — the auth-escalation flow owns their lifecycle and any
    // provider call here would just re-trigger the same `invalid_grant` on every webhook delivery.
    if (integrationStatus(integration) !== 'active') {
        console.log(`[calendar-webhook] skipping ${integrationStatus(integration)} integration ${integration._id}`);
        return;
    }
    const provider = buildProvider(integration, config.user);
    const now = dayjs().toISOString();
    const ctx: SyncContext = { userId: config.user, now, ops: [] };
    await withAuthFailureHandling(integration._id, () => syncSingleCalendar(config, integration, provider, ctx));
    console.log(`[gcal-webhook-sync] sync complete | configId=${config._id} ops=${ctx.ops.length}`);
    // Keep webhook channel alive — renew if close to expiring so the next change also triggers a webhook.
    await renewWebhookIfExpired(config, provider, integration._id).catch((err) => {
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
            // Skip suspended/revoked integrations — the auth-escalation flow owns their lifecycle.
            if (integrationStatus(integration) !== 'active') {
                return;
            }
            const provider = buildProvider(integration, config.user);
            await renewWebhookIfExpired(config, provider, integration._id);
        }),
    );

    const failed = results.filter((r) => r.status === 'rejected').length;
    return c.json({ renewed: results.length - failed, failed });
});

export { calendarRoutes };
