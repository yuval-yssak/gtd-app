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
import { isDuplicateKeyError } from '../lib/mongoErrors.js';
import { recordOperation } from '../lib/operationHelpers.js';
import {
    buildCalendarInstanceEventId,
    normalizeMasterEventId,
    propagateRoutineTitleToItems,
    regenerateFutureRoutineItems,
    routineGeneratesOccurrenceOnDate,
} from '../lib/routineItemRegeneration.js';
import { extractUntilFromRrule } from '../lib/rruleHelpers.js';
import { applyRsvpToAttendees, resolveSyncConfigForItem } from '../lib/rsvpHelpers.js';
import { notifyUserViaSse } from '../lib/sseConnections.js';
import { stableStringify } from '../lib/stableStringify.js';
import { hasAtLeastOne, type NonEmptyArray } from '../lib/typeUtils.js';
import { notifyViaWebPush } from '../lib/webPush.js';
import { auth } from '../loaders/mainLoader.js';
import type { AuthVariables } from '../types/authTypes.js';
import {
    type CalendarIntegrationInterface,
    type CalendarSyncConfigInterface,
    GCAL_OWNED_ITEM_KEYS,
    GCAL_OWNED_ROUTINE_KEYS,
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
export type SyncContext = { userId: string; now: string; ops: OperationInterface[]; timeZone?: string };
type RoutineSyncCtx = { userId: string; since: string; now: string; calendarId: string; ops: OperationInterface[]; timeZone?: string };
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
    /**
     * The active-session user id at /auth/google time. Retained for CSRF/audit context and HMAC
     * binding, but NOT used to choose the integration owner — the callback resolves the owner from
     * the authorized Google email against the device's signed-in sessions instead, so a drifted
     * active-session cookie can't attach the integration to the wrong account.
     */
    userId: string;
    /** Email of the Google account the user expects to authorize. The callback requires the authorized email to match it. */
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
    // account email matches the hint and attaches the integration to whichever signed-in account
    // owns that Google identity — preventing a user from accidentally authorizing an unrelated
    // Google identity, and tolerating drift between the app's active account and the API-origin cookie.
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
        // `select_account` forces Google's account chooser even when a Google session is already
        // signed in — without it, connecting a SECOND account silently reuses the first signed-in
        // identity, so the callback's email-mismatch guard rejects the connect ("authorized account
        // didn't match the one you selected"). `consent` is kept so we still always get a refresh token.
        prompt: 'select_account consent',
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
    // `state.userId` (the cookie-derived id at /auth/google time) is intentionally NOT read here:
    // the integration owner is resolved from the authorized Google email instead, so a drifted
    // active-session cookie can't attach the integration to the wrong signed-in account.
    const { loginHint, intent } = state;

    const oauth2 = buildOAuthClient();
    const tokenResult = await tryExchangeOAuthTokens(oauth2, code);
    if (!tokenResult.ok) {
        return tokenResult.reason === 'missing_tokens'
            ? c.text('OAuth did not return required tokens', 400)
            : c.text('Failed to exchange OAuth code for tokens', 502);
    }
    const { accessToken, refreshToken, expiryDate, grantedScopes } = tokenResult;

    // Verify the user actually authorized the account they targeted, then attach the integration to
    // the GTD account that OWNS that Google identity — NOT the state's `userId` (which is stamped
    // from the ambient active-session cookie at /auth/google time and can point at a different
    // signed-in account when the app's active account and the API-origin session cookie have drifted;
    // that drift was the "switches me back to my work account" mismatch). We resolve the owner by
    // matching the authorized Google email against the device's signed-in sessions, so the integration
    // lands on the right account regardless of which session the cookie happened to point at.
    oauth2.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
    const authorizedEmail = await tryFetchAuthorizedEmail(oauth2);
    const ownerUserId = await resolveOwnerUserIdForAuthorizedEmail(c.req.raw.headers, authorizedEmail);
    if (!authorizedConnectIsValid(authorizedEmail, loginHint, ownerUserId)) {
        await oauth2.revokeToken(accessToken).catch(() => {});
        if (intent === 'rsvp') {
            return renderPopupCloser(c, { ok: false, reason: 'mismatch' });
        }
        return c.redirect(`${clientUrl}/settings?calendarConnectError=mismatch`);
    }

    const now = dayjs().toISOString();
    const integration: CalendarIntegrationInterface = {
        _id: randomUUID(),
        user: ownerUserId,
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
    // Scoped to `ownerUserId` (the resolved Google-identity owner), matching the integration above.
    await clearOrphanedLastKnownMarkers(ownerUserId);

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

/**
 * Resolves which GTD account should OWN a calendar integration for the just-authorized Google
 * identity. Matches `authorizedEmail` (case-insensitive) against every account signed in on this
 * device and returns that account's userId — this is the fix for the cookie/IDB drift: the owner is
 * derived from the Google identity the user actually authorized, not from whichever session the
 * API-origin cookie happened to point at.
 *
 * The candidate set is the active session (`getSession`, always available from the main session
 * cookie — covers the single-account case) UNION the device's other signed-in sessions
 * (`listDeviceSessions`, set only after "add another account" — covers the multi-account drift case).
 *
 * Returns null when no signed-in account owns the authorized email (or there's no authorized email).
 * The callback treats null as a mismatch and revokes the tokens — the security guard: we only ever
 * attach an integration to an account the user is actually signed in as, never to a Google identity
 * with no corresponding session on this device.
 */
async function resolveOwnerUserIdForAuthorizedEmail(headers: Headers, authorizedEmail: string | null): Promise<string | null> {
    if (!authorizedEmail) {
        return null;
    }
    const candidates = await signedInAccountsForDevice(headers);
    const target = authorizedEmail.toLowerCase();
    return candidates.find((a) => a.email.toLowerCase() === target)?.id ?? null;
}

/**
 * Enumerates every account signed in on this device: the active session plus any additional
 * multi-session accounts, de-duplicated by userId. Each lookup degrades to empty on failure so a
 * transient error in one source still lets the other resolve an owner.
 */
async function signedInAccountsForDevice(headers: Headers): Promise<Array<{ id: string; email: string }>> {
    const [active, deviceSessions] = await Promise.all([tryFetchActiveAccount(headers), tryListDeviceSessions(headers)]);
    const byId = new Map<string, { id: string; email: string }>();
    for (const account of [...(active ? [active] : []), ...deviceSessions]) {
        byId.set(account.id, account);
    }
    return [...byId.values()];
}

/** Resolves the active session's account from the main session cookie; null when there's no active session. */
async function tryFetchActiveAccount(headers: Headers): Promise<{ id: string; email: string } | null> {
    try {
        const session = await auth.api.getSession({ headers });
        return session ? { id: session.user.id, email: session.user.email } : null;
    } catch {
        return null;
    }
}

/** Lists the device's additional signed-in sessions; returns [] on any failure so resolution degrades to the active account. */
async function tryListDeviceSessions(headers: Headers): Promise<Array<{ id: string; email: string }>> {
    try {
        const sessions = await auth.api.listDeviceSessions({ headers });
        return sessions.map((s) => ({ id: s.user.id, email: s.user.email }));
    } catch {
        return [];
    }
}

/**
 * A connect is valid when the authorized Google email matches the login_hint we sent (when present)
 * AND we resolved a GTD owner account for it. `authorizedEmail` is required (we just got it from
 * Google). Requiring `loginHint` to match guards against the user picking a different account in
 * Google's chooser than the one the app intended to connect.
 */
function authorizedConnectIsValid(authorizedEmail: string | null, loginHint: string | undefined, ownerUserId: string | null): ownerUserId is string {
    if (!authorizedEmail || !ownerUserId) {
        return false;
    }
    if (loginHint && authorizedEmail.toLowerCase() !== loginHint.toLowerCase()) {
        return false;
    }
    return true;
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
        // Free `calendarInstanceEventId` on trash so a reconnect re-import can regenerate these
        // occurrences — a trashed item otherwise keeps reserving its id on the presence-partial
        // unique index, silently E11000-blocking the new routine's inserts (→ invisible series).
        await itemsDAO.updateMany(
            { _id: { $in: openIds }, user: userId },
            { $set: { status: 'trash', updatedTs: now }, $unset: { calendarInstanceEventId: '' } },
        );
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
    // Defensive normalization: a freshly-created GCal event should already have a bare master id,
    // but `normalizeMasterEventId` is idempotent on bare ids and protects against provider quirks.
    const calendarEventId = normalizeMasterEventId(createResult.calendarEventId);

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
            // Acquire-and-await the per-calendar lock so this manual sync serializes behind any in-flight
            // webhook sync (and vice-versa) instead of racing it — the caller still gets a fresh result.
            const count = await withSyncLock(config, () =>
                withAuthFailureHandling(integration._id, () => syncSingleCalendar(config, integration, provider, { userId, now, ops })),
            );
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

    const syncCtx: RoutineSyncCtx = {
        userId: ctx.userId,
        since,
        now: ctx.now,
        calendarId: config.calendarId,
        ops: ctx.ops,
        ...(config.timeZone ? { timeZone: config.timeZone } : {}),
    };
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
    // Stored `calendarEventId` is always the bare master id (normalized at write time by
    // `importRecurringEventAsRoutine`). Inbound ids may still carry the `_R<...>` rebased-master
    // suffix, so normalize on both sides of every comparison below.
    const knownRoutineEventIds = new Set(existingLinkedRoutines.map((r) => r.calendarEventId).filter((id): id is string => Boolean(id)));

    const isRecurringMaster = (e: GCalEvent) => hasAtLeastOne(e.recurrence ?? []) || knownRoutineEventIds.has(normalizeMasterEventId(e.id));
    const recurringMasters = events.filter(isRecurringMaster);
    const regularEvents = events.filter((e) => !isRecurringMaster(e));

    // Import recurring masters as routines, ordered so a GCal "this and all following" split is
    // handled deterministically: the capped base master must pause its routine BEFORE the open-ended
    // `_R<…>` successor inserts its own active routine on the same bare id (else the active-partial
    // unique index would reject the successor). See `classifyRecurringMaster`.
    await importRecurringMastersOrdered(recurringMasters, existingLinkedRoutines, source, ctx);

    // Re-fetch after importing new recurring masters so freshly created routines are included.
    const allLinkedRoutines = await routinesDAO.findArray({
        user: ctx.userId,
        calendarIntegrationId: source.integration._id,
        calendarEventId: { $exists: true },
    });
    const routineEventIds = new Set(allLinkedRoutines.map((r) => r.calendarEventId).filter((id): id is string => Boolean(id)));

    // Detect GCal series splits ("this and all following") and link new routines to their parent.
    await detectAndLinkSplits(existingLinkedRoutines, allLinkedRoutines, recurringMasters, ctx);

    // An instance's `recurringEventId` can also carry the `_R<...>` rebased-master suffix; normalize
    // before lookup so series instances are correctly filtered out (otherwise they'd surface as
    // duplicate standalone items alongside the routine-generated ones).
    const eventsToUpsert = regularEvents.filter((e) => !e.recurringEventId || !routineEventIds.has(normalizeMasterEventId(e.recurringEventId)));
    await Promise.all(eventsToUpsert.map((event) => upsertCalendarItem(event, source, ctx)));
}

/** True when a raw GCal master id carries the `_R<YYYYMMDD[THHMMSS[Z]]>` rebased-master suffix. */
function hasRebasedSuffix(rawId: string): boolean {
    return rawId !== normalizeMasterEventId(rawId);
}

/** True when an rrule string has no UNTIL clause (an open-ended, still-live series). */
function isOpenRrule(rrule: string): boolean {
    return !rrule.includes('UNTIL=');
}

/**
 * Classify an inbound recurring-master event in the context of its sync batch + existing routines.
 *
 * A GCal "this and all following" split produces TWO masters that both normalize to one bare id:
 * the capped base `<id>` (gains a past UNTIL) and an open-ended successor `<id>_R<anchor>`. The
 * unconditional `normalizeMasterEventId` in `importRecurringEventAsRoutine` would collapse the
 * successor onto the base routine and never onboard it as its own live series → the series goes
 * invisible in the app. We must instead route the successor to its own NEW active routine.
 *
 * - `'splitSuccessor'`: an open-ended `_R<…>` event whose bare base is also present as a capped/cancelled
 *   master in this batch, OR matches an existing routine on the bare id that is capped (UNTIL) or inactive.
 *   This is the live tail of a split — onboard it as a distinct routine keyed on the BARE id (GCal's
 *   instance ids use the bare id, so `buildCalendarInstanceEventId` matches → no duplicate items).
 * - `'reReport'`: everything else, including the case where ONLY the `_R` event arrives with no
 *   capped sibling/routine (Google re-reporting a single master with a rebased id). Keep the existing
 *   normalize-onto-existing behavior — this preserves the duplicate-items fix.
 *
 * Exported for unit testing.
 */
export function classifyRecurringMaster(event: GCalEvent, batch: GCalEvent[], existingRoutines: RoutineInterface[]): 'reReport' | 'splitSuccessor' {
    if (!hasRebasedSuffix(event.id) || event.status !== 'confirmed') {
        return 'reReport';
    }
    const rrule = extractRrule(event.recurrence ?? []);
    if (!rrule || !isOpenRrule(rrule)) {
        return 'reReport';
    }
    const bareId = normalizeMasterEventId(event.id);
    // (4a) A distinct base master in the same batch that is itself capped or cancelled.
    const cappedSiblingInBatch = batch.some((e) => {
        if (e.id !== bareId) {
            return false;
        }
        if (e.status === 'cancelled') {
            return true;
        }
        const siblingRrule = extractRrule(e.recurrence ?? []);
        return siblingRrule !== null && !isOpenRrule(siblingRrule);
    });
    // (4b) An existing routine on the bare id that is already capped (UNTIL) or paused.
    const cappedExistingRoutine = existingRoutines.some((r) => r.calendarEventId === bareId && (!r.active || !isOpenRrule(r.rrule)));
    return cappedSiblingInBatch || cappedExistingRoutine ? 'splitSuccessor' : 'reReport';
}

/**
 * Imports recurring masters in an order that makes "this and all following" splits deterministic.
 *  - Phase 1 (sequential): base/capped masters + `reReport` events. Running the capped base FIRST
 *    pauses its routine (active:false) before any successor inserts.
 *  - Phase 2 (sequential per bare-id group): `_R<…>` split successors. Sequencing per bare id avoids
 *    a Promise.all race when GCal split the same series twice (two `_R` masters → one bare id).
 */
async function importRecurringMastersOrdered(
    masters: GCalEvent[],
    existingRoutines: RoutineInterface[],
    source: CalendarSource,
    ctx: SyncContext,
): Promise<void> {
    const successors = masters.filter((e) => classifyRecurringMaster(e, masters, existingRoutines) === 'splitSuccessor');
    const successorIds = new Set(successors.map((e) => e.id));
    const phaseOne = masters.filter((e) => !successorIds.has(e.id));

    for (const event of phaseOne) {
        await importRecurringEventAsRoutine(event, source, ctx);
    }
    // Group successors by bare id; run each group sequentially so two successors on the same series
    // don't race their inserts. Distinct series run in parallel — safe against the unique active index
    // because its key includes calendarEventId, which differs per group, and all events here share one
    // `source` (single integration). A future multi-integration importCalendarEvents would need to
    // re-check this invariant.
    const byBareId = new Map<string, GCalEvent[]>();
    for (const event of successors) {
        const key = normalizeMasterEventId(event.id);
        byBareId.set(key, [...(byBareId.get(key) ?? []), event]);
    }
    await Promise.all(
        [...byBareId.values()].map(async (group) => {
            for (const event of group) {
                await importRecurringEventAsRoutine(event, source, ctx, { forceSplitSuccessor: true });
            }
        }),
    );
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

        // Match on the normalized master id — `tail.calendarEventId` is stored normalized by
        // `importRecurringEventAsRoutine`, while `masterEvents` carries raw GCal ids that may
        // still bear the `_R<…>` rebased-master suffix.
        const event = masterEvents.find((e) => normalizeMasterEventId(e.id) === tail.calendarEventId);
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
 *
 * `event.id` is normalized via `normalizeMasterEventId` before any persistence or lookup, so a
 * GCal rebased-master id like `<masterId>_R<YYYYMMDDTHHMMSS>` is collapsed to the bare master id.
 * Without this, downstream `buildCalendarInstanceEventId` produces double-anchored instance ids
 * that never match GCal payloads → reconcile orphan-creates a duplicate item per occurrence.
 */
async function importRecurringEventAsRoutine(
    rawEvent: GCalEvent,
    source: CalendarSource,
    ctx: SyncContext,
    opts?: { forceSplitSuccessor?: boolean },
): Promise<void> {
    const event: GCalEvent = { ...rawEvent, id: normalizeMasterEventId(rawEvent.id) };
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

    // Split-successor path: the open-ended `_R<…>` tail of a "this and all following" split must become
    // its OWN active routine on the bare id, NOT overwrite the capped (now-inactive) parent that
    // `findExistingRoutineForEvent` resolves to. `event.id` is already the bare id (normalized above), so
    // the new routine + its generated items match GCal's bare-id instance ids — no duplicate items.
    if (opts?.forceSplitSuccessor) {
        // Idempotency on the raw rebased id (`rawEvent.id` still carries the `_R<anchor>` suffix). The
        // SAME successor re-arriving must update the SAME routine, regardless of its active flag — phase 1
        // of the same batch imports the capped base and (because base + successor share a bare
        // calendarEventId) can flip this successor to active:false. Matching on the stable rebased id and
        // reactivating reverses that erroneous cap, so a re-reported split converges instead of minting a
        // fresh routine every webhook fire (the unbounded-chain bug).
        const successor = await findSplitSuccessorByRebasedId(rawEvent.id, source, ctx);
        if (successor) {
            console.log(
                `[gcal-sync] updating split-successor routine (rebased-id match) | rebasedId=${rawEvent.id} routineId=${successor._id} active=${successor.active}`,
            );
            // Pass the successor as-is: when phase 1's base import wrongly capped it (active:false + UNTIL
            // rrule), `updateRoutineFromGCal`'s `newlyLosesUntil` gate reactivates it from the open inbound
            // rrule. Pre-setting active:true here would instead DEFEAT that gate (it requires !existing.active).
            await updateRoutineFromGCal(successor, event, rrule, source, ctx);
            return;
        }
        // Legacy fallback (pre-rebased-id routines): an already-active routine on the bare id IS the
        // successor → update it, never the inactive parent. `findExistingRoutineForEvent` prefers active.
        if (existing?.active) {
            console.log(`[gcal-sync] updating split-successor routine | eventId=${event.id} title=${event.title} routineId=${existing._id}`);
            await updateRoutineFromGCal(existing, event, rrule, source, ctx);
            return;
        }
        const parentId = await resolveSplitParentId(event.id, source, ctx);
        console.log(`[gcal-sync] creating split-successor routine | eventId=${event.id} title=${event.title} rrule=${rrule} parent=${parentId ?? 'none'}`);
        await createRoutineFromGCal(event, rrule, source, ctx, { rebasedEventId: rawEvent.id, ...(parentId ? { splitFromRoutineId: parentId } : {}) });
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
 * Find a split-successor routine by its stable raw rebased GCal id (`<bareId>_R<anchor>`). This is the
 * idempotency key that lets a re-reported `_R` master re-find the same successor instead of creating a
 * new one — see `RoutineInterface.calendarRebasedEventId`. Matches active OR capped (a same-batch base
 * import may have wrongly capped it); the caller reactivates.
 */
async function findSplitSuccessorByRebasedId(rebasedEventId: string, source: CalendarSource, ctx: SyncContext): Promise<RoutineInterface | undefined> {
    const matches = await routinesDAO.findArray({
        user: ctx.userId,
        calendarRebasedEventId: rebasedEventId,
        calendarIntegrationId: source.integration._id,
    });
    return hasAtLeastOne(matches) ? pickMostRecentlyUpdated(matches) : undefined;
}

/**
 * Resolve the capped/paused parent routine for a split successor — the routine sharing the bare
 * `calendarEventId` that is inactive or holds an UNTIL (the segment GCal capped when the user chose
 * "this and all following"). Returns the most-recently-updated such routine's id, or undefined if none
 * (a webhook may deliver the successor before the cap landed; the successor is still created, unlinked).
 */
async function resolveSplitParentId(bareEventId: string, source: CalendarSource, ctx: SyncContext): Promise<string | undefined> {
    const candidates = await routinesDAO.findArray({
        user: ctx.userId,
        calendarEventId: bareEventId,
        calendarIntegrationId: source.integration._id,
    });
    const capped = candidates.filter((r) => !r.active || r.rrule.includes('UNTIL='));
    return hasAtLeastOne(capped) ? pickMostRecentlyUpdated(capped)._id : undefined;
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
    const byEventId = await routinesDAO.findArray({
        user: ctx.userId,
        calendarEventId: event.id,
        calendarIntegrationId: source.integration._id,
    });
    if (hasAtLeastOne(byEventId)) {
        // When duplicate routines linger on the same series, an inbound master update must land on the
        // live one — never on a paused/replaced dead duplicate. Among live routines (or, if none are
        // live, among all), prefer the most-recently-updated so selection is deterministic.
        const live = byEventId.filter((routine) => routine.active);
        return pickMostRecentlyUpdated(hasAtLeastOne(live) ? live : byEventId);
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
    const naked = await routinesDAO.findArray({
        user: ctx.userId,
        active: true,
        routineType: 'calendar',
        calendarEventId: { $exists: false },
        calendarIntegrationId: { $exists: false },
        title: event.title,
        rrule,
        // All-day-aware: a naked all-day routine's template is { allDay: true } with no timeOfDay/duration,
        // so matching on the timed fields would never find it and the caller would orphan-create a
        // duplicate on reconnect. Mirrors buildCalendarItemTemplate's all-day branch.
        ...buildNakedTemplateMatch(event, source.config.timeZone ?? 'UTC'),
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

async function createRoutineFromGCal(
    event: GCalEvent,
    rrule: string,
    source: CalendarSource,
    ctx: SyncContext,
    opts?: { splitFromRoutineId?: string; rebasedEventId?: string },
): Promise<void> {
    // All-day routines skip the time/duration extraction — GCal emits `start.date` (YYYY-MM-DD)
    // with no time component, so `extractLocalTime` and the `diff('minute')` math would both yield
    // junk. Downstream item generation reads `template.allDay` to switch to the all-day shape
    // (`routineItemRegeneration.buildCalendarItem` + the client's `buildCalendarItem`).
    const calendarItemTemplate = buildCalendarItemTemplate(event, source.config.timeZone ?? 'UTC');

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
        // A master that arrives already capped (UNTIL in the past or future) is a historical/closed
        // segment, not a live series — create it paused. Only `updateRoutineFromGCal`'s `newlyGainsUntil`
        // path previously enforced this; a freshly-imported capped master (e.g. the base side of a
        // cold-start split where both masters arrive at once) must not become active and then collide
        // with its open-ended successor on the active-partial unique index.
        active: isOpenRrule(rrule),
        calendarEventId: event.id,
        calendarIntegrationId: source.integration._id,
        calendarSyncConfigId: source.config._id,
        calendarItemTemplate,
        template: event.description != null ? { notes: htmlToMarkdown(event.description) } : {},
        ...(event.description != null ? { lastSyncedNotes: event.description } : {}),
        // Mirror the GCal master's organizer/creator/attendees/responseStatus/eventType onto the
        // routine doc. `buildCalendarItem` copies these onto every generated occurrence so the
        // first sync after import already produces meeting-aware items.
        ...pickGCalOwnedFields(event),
        // Record split lineage when this routine is the open-ended tail of a "this and all following"
        // split. The `_R<…>` successor shares the parent's bare calendarEventId, so the gap-window
        // heuristic in `pickSplitParent`/`detectAndLinkSplits` can't reliably pair them when the cap
        // and the first tail occurrence are far apart — the caller passes the parent id directly.
        ...(opts?.splitFromRoutineId ? { splitFromRoutineId: opts.splitFromRoutineId } : {}),
        // Stable per-tail key for split successors (see RoutineInterface.calendarRebasedEventId). Lets a
        // re-reported `_R` master re-find THIS routine instead of minting a new one each sync.
        ...(opts?.rebasedEventId ? { calendarRebasedEventId: opts.rebasedEventId } : {}),
        // Anchor the GCal-truth timestamp on create so the first inbound update's structural gate
        // compares against the real GCal payload, not the self-bumped updatedTs. Mirrors createNewCalendarItem.
        lastSyncedFromGCalTs: event.updated,
        createdTs,
        updatedTs: ctx.now,
    };

    try {
        await routinesDAO.insertOne(routine);
    } catch (err) {
        // The unique partial index (uniq_active_routine_per_gcal_series) makes a second active routine
        // on the same (user, calendarEventId, integration) impossible. A concurrent webhook that already
        // created the live routine makes us the race loser — re-resolve and update that one instead of
        // duplicating. Mirrors the item-side race-loser pattern in createItemForOrphanedException.
        if (isDuplicateKeyError(err)) {
            const existing = await findExistingRoutineForEvent(event, rrule, source, ctx);
            if (existing) {
                console.warn(`[gcal-sync] createRoutineFromGCal raced E11000 — updating existing routine | eventId=${event.id} routineId=${existing._id}`);
                await updateRoutineFromGCal(existing, event, rrule, source, ctx);
                return;
            }
        }
        throw err;
    }
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

/**
 * Builds a routine's `calendarItemTemplate` from a GCal master, branching on `event.allDay`.
 * Shared by both the create (`createRoutineFromGCal`) and update (`updateRoutineFromGCal`) paths so
 * an all-day master never gets a `{ timeOfDay, duration }` template — for an all-day event
 * `event.timeStart` is a `YYYY-MM-DD` string, so `extractLocalTime`/`diff` would yield junk
 * (e.g. timeOfDay="03:00" in UTC+3, the all-day banner rendering as 03:00–03:00). The update path
 * previously recomputed the timed template unconditionally, silently clobbering `allDay`.
 */
function buildCalendarItemTemplate(event: GCalEvent, timeZone: string): NonNullable<RoutineInterface['calendarItemTemplate']> {
    return event.allDay ? { allDay: true as const } : buildTimedTemplate(event, timeZone);
}

/**
 * Builds the `calendarItemTemplate.*` sub-document filter used by `findExistingRoutineForEvent` to
 * relink a naked routine to its re-imported GCal master. Branches on `event.allDay` for the same
 * reason as `buildCalendarItemTemplate`: an all-day naked routine stores `{ allDay: true }` (no
 * timeOfDay/duration), so matching on the timed fields derived from a YYYY-MM-DD string would find
 * nothing and the caller would orphan-create a duplicate routine on reconnect.
 */
function buildNakedTemplateMatch(event: GCalEvent, timeZone: string) {
    if (event.allDay) {
        return { 'calendarItemTemplate.allDay': true };
    }
    return {
        'calendarItemTemplate.timeOfDay': extractLocalTime(event.timeStart, timeZone),
        'calendarItemTemplate.duration': dayjs(event.timeEnd).diff(dayjs(event.timeStart), 'minute'),
    };
}

async function updateRoutineFromGCal(existing: RoutineInterface, event: GCalEvent, rrule: string, source: CalendarSource, ctx: SyncContext): Promise<void> {
    const routineId = existing._id;

    // Determine notes update independently of structural fields.
    // For routines, GCal description maps to template.notes (not a top-level notes field).
    const notesUpdate = resolveInboundNotes(event.description, existing.lastSyncedNotes, event.updated, existing.updatedTs);

    // Gate structural changes on `lastSyncedFromGCalTs` (the GCal-side anchor of the last applied
    // master payload), NOT `updatedTs`. Local-only writes and no-op exception churn bump `updatedTs`
    // to "now", which would otherwise make `existing` always look newer than GCal's months-old
    // `event.updated` and permanently lock GCal out of correcting a stale rrule/UNTIL. The epoch
    // fallback makes any real GCal payload win when the anchor is unset (mirrors updateExistingCalendarItem;
    // `dayjs('')` is NaN and would instead let GCal lose every comparison). NOTE the comparison operator
    // differs from updateExistingCalendarItem by design: routines keep their existing `isGCalAtLeastAsRecent`
    // (`>=`, second precision) convention; the item path uses raw string `>` (ms, strict). Only the anchor
    // FIELD is unified across the two paths, not the comparison semantics.
    const structurallyNewer = isGCalAtLeastAsRecent(event.updated, existing.lastSyncedFromGCalTs ?? '1970-01-01T00:00:00.000Z');
    // GCal-owned routine fields (organizer/creator/attendees/responseStatus/eventType) flow through
    // even when the event timestamp is older — these are server-authoritative regardless of LWW so
    // an attendee-only edit on GCal can't be locked out by a stale local update bumping updatedTs.
    const gcalOwnedDelta = hasGCalOwnedRoutineDelta(existing, event);
    if (!structurallyNewer && !notesUpdate && !gcalOwnedDelta) {
        return;
    }
    // GCal-owned-only path: avoids the read→merge→replaceById race for older webhooks. Targets
    // only the GCal-owned keys (GCAL_OWNED_ROUTINE_KEYS) via $set/$unset and bypasses the structural merge.
    if (!structurallyNewer && !notesUpdate) {
        await applyGCalOwnedRoutineDeltaOnly(existing, event, ctx);
        return;
    }

    // All-day-aware: an all-day master must keep `{ allDay: true }`, not be recomputed as a timed
    // `{ timeOfDay, duration }` template (which would render the banner as 03:00–03:00). Mirrors createRoutineFromGCal.
    const calendarItemTemplate = buildCalendarItemTemplate(event, source.config.timeZone ?? 'UTC');
    const newlyGainsUntil = structurallyNewer && !existing.rrule.includes('UNTIL=') && rrule.includes('UNTIL=');
    // Symmetric inverse: GCal removed the UNTIL (series uncapped), so a routine previously capped-and-
    // paused must reactivate. Without this, a routine stranded inactive with a stale past UNTIL stays
    // invisible forever even after GCal re-extends the series. Only fires when the local routine was
    // capped (had UNTIL) and is currently inactive — a user-paused routine on a still-uncapped series
    // is untouched.
    const newlyLosesUntil = structurallyNewer && existing.rrule.includes('UNTIL=') && !rrule.includes('UNTIL=') && !existing.active;

    // Re-fetch: routineExceptions may have been written by syncRoutineExceptions earlier in the same
    // sync cycle, and the `existing` snapshot we were passed predates that write. Using the stale
    // snapshot as the base for replaceById would drop those exceptions.
    const fresh = (await routinesDAO.findByOwnerAndId(routineId, ctx.userId)) ?? existing;

    // Build the merged routine, then explicitly clear any GCal-owned key absent from the inbound
    // event so a stale local attendee list cannot survive when GCal removes the last attendee.
    const mergedWithGCalOwned: RoutineInterface = {
        ...fresh,
        ...(structurallyNewer
            ? {
                  title: event.title,
                  rrule,
                  calendarSyncConfigId: source.config._id,
                  calendarItemTemplate,
                  // Advance the GCal-truth anchor only on a structurally-newer payload — symmetric with
                  // updateExistingCalendarItem. An out-of-order older payload must not regress it.
                  lastSyncedFromGCalTs: event.updated,
                  // Mirror client-side splitRoutine: capping the parent pauses it so the UI
                  // reflects that the segment is historical. Without this, a capped-in-the-past
                  // routine shows as "Active" even though it no longer generates instances.
                  ...(newlyGainsUntil ? { active: false } : {}),
                  // Inverse: GCal uncapped the series → reactivate a previously capped+paused routine.
                  ...(newlyLosesUntil ? { active: true } : {}),
              }
            : {}),
        ...(notesUpdate
            ? {
                  // Falsy (empty string) means GCal cleared the description — remove template.notes entirely.
                  template: notesUpdate.notes ? { ...fresh.template, notes: notesUpdate.notes } : omitNotes(fresh.template),
                  lastSyncedNotes: notesUpdate.lastSyncedNotes,
              }
            : {}),
        ...pickGCalOwnedFields(event),
        updatedTs: ctx.now,
    };
    const updated = clearOmittedGCalOwnedRoutineFields(mergedWithGCalOwned, event);

    // No-op guard: `structurallyNewer` uses `>=` (GCal wins ties within the same second), so an
    // *unchanged* GCal event whose `updated` equals the stored `lastSyncedFromGCalTs` still counts as
    // "structurally newer" and falls through here every webhook fire. Without this, the routine was
    // rewritten with an identical snapshot (only `updatedTs` differs) and a redundant `update` op was
    // emitted each sync — bloating the op log and spamming web push. Skip only the routine-entity
    // write when nothing but `updatedTs` changed; item-side propagation below has its own guards.
    if (stableStringify({ ...updated, updatedTs: '' }) !== stableStringify({ ...fresh, updatedTs: '' })) {
        await routinesDAO.replaceById(routineId, updated);
        ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'routine', entityId: routineId, snapshot: updated, opType: 'update', now: ctx.now }));
    }

    // When GCal adds UNTIL (series split via "this and all following"), trash items past the UNTIL date.
    if (newlyGainsUntil) {
        const untilDate = extractUntilFromRrule(rrule);
        if (untilDate) {
            await updateItemsAndRecordOps(ctx, {
                filter: { user: ctx.userId, routineId, status: 'calendar', timeStart: { $gt: untilDate } },
                setFields: { status: 'trash', updatedTs: ctx.now },
                unsetFields: { calendarInstanceEventId: '' },
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
    // GCal-owned master changes (attendee added/removed, organizer changed, eventType flipped) must
    // reach existing items too, independent of schedule/title propagation. Items that already carry
    // a per-instance routine exception (override) keep their per-key override values.
    if (gcalOwnedDelta) {
        await propagateMasterGCalOwnedChangesToItems(updated, ctx);
    }
}

/**
 * Pushes GCal-owned master changes (attendees, organizer, creator, responseStatus, eventType) onto
 * every generated calendar item for this routine, EXCEPT items whose matching routineException
 * carries a per-key override (those keep their override per RFC 5545 inheritance).
 *
 * Walks items, computes the merged GCal-owned slice (master ∪ per-instance override) for each, and
 * writes the result via per-item `$set`/`$unset` so a removed master attendee actually clears on
 * items that previously inherited it. Each write records an op so other devices converge via pull.
 */
async function propagateMasterGCalOwnedChangesToItems(routine: RoutineInterface, ctx: SyncContext): Promise<void> {
    const items = await itemsDAO.findArray({ user: ctx.userId, routineId: routine._id, status: 'calendar' });
    if (items.length === 0) {
        return;
    }
    const exceptionsByDate = new Map((routine.routineExceptions ?? []).filter((e) => e.type === 'modified').map((e) => [e.date, e]));
    const masterSlice = pickGCalOwnedRoutineFields(routine);

    await Promise.all(
        items.map(async (item) => {
            const itemId = item._id;
            if (!itemId) {
                return;
            }
            const occurrenceDate = (item.timeStart ?? '').slice(0, 10);
            const override = exceptionsByDate.get(occurrenceDate);
            // Per-key merge: exception override wins per-key; absent override key ⇒ inherit master.
            const overrideSlice = override ? pickGCalOwnedExceptionFields(override) : {};
            const merged = { ...masterSlice, ...overrideSlice };
            const updateOps = buildGCalOwnedFieldUpdate(merged);
            if (updateOps.$set === undefined && updateOps.$unset === undefined) {
                return;
            }
            const setOps = { ...(updateOps.$set ?? {}), updatedTs: ctx.now };
            // Mirrors applyModifiedExceptionToOne: filter on the snapshot's updatedTs so a
            // concurrent /sync/push edit landing between the find and the write loses cleanly.
            const result = await itemsDAO.updateOne({ _id: itemId, user: ctx.userId, updatedTs: item.updatedTs } as never, {
                $set: setOps,
                ...(updateOps.$unset ? { $unset: updateOps.$unset } : {}),
            });
            if (result.matchedCount === 0) {
                console.log(`[gcal-sync] propagateMasterGCalOwnedChangesToItems: skipped due to concurrent updatedTs bump | itemId=${itemId}`);
                return;
            }
            const refreshed = await itemsDAO.findByOwnerAndId(itemId, ctx.userId);
            if (!refreshed) {
                return;
            }
            ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'item', entityId: itemId, snapshot: refreshed, opType: 'update', now: ctx.now }));
        }),
    );
}

/**
 * Builds `$set` / `$unset` slices for a Mongo update so a GCal-owned key whose target value is
 * undefined gets `$unset` (clearing inherited stale values) and present keys get `$set`. Returns
 * undefined slices when neither operation has any keys, so the caller can skip the write.
 */
function buildGCalOwnedFieldUpdate(merged: Partial<Pick<RoutineInterface, (typeof GCAL_OWNED_ROUTINE_KEYS)[number]>>): {
    $set?: Record<string, unknown>;
    $unset?: Record<string, ''>;
} {
    const setOps: Record<string, unknown> = {};
    const unsetOps: Record<string, ''> = {};
    for (const key of GCAL_OWNED_ROUTINE_KEYS) {
        const value = merged[key];
        if (value === undefined) {
            unsetOps[key] = '';
        } else {
            setOps[key] = value;
        }
    }
    return {
        ...(Object.keys(setOps).length > 0 ? { $set: setOps } : {}),
        ...(Object.keys(unsetOps).length > 0 ? { $unset: unsetOps } : {}),
    };
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

    // Trash all future items belonging to this routine — freeing their instance ids so a replacement
    // routine on the same series can regenerate them.
    await updateItemsAndRecordOps(ctx, {
        filter: { user: ctx.userId, routineId, status: 'calendar', timeStart: { $gte: ctx.now } },
        setFields: { status: 'trash', updatedTs: ctx.now },
        unsetFields: { calendarInstanceEventId: '' },
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
    meetingLink?: string;
    location?: string;
    htmlLink?: string;
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
        ...(event.meetingLink !== undefined ? { meetingLink: event.meetingLink } : {}),
        ...(event.location !== undefined ? { location: event.location } : {}),
        ...(event.htmlLink !== undefined ? { htmlLink: event.htmlLink } : {}),
    };
}

/**
 * Routine-surface mirror of `pickGCalOwnedFields`. Extracts the GCal-owned set from any source
 * carrying the same five optional keys (a routine doc, an exception entry, or another routine
 * write path) so callers can spread it onto a generated item or persisted record. The two surfaces
 * (routine master + per-instance exception) share the exact same key types, so a single helper
 * is enough — drift between them would fail compile via the explicit `Pick<RoutineInterface, K>`.
 */
type GCalOwnedRoutineSource = {
    organizer?: GCalPerson;
    creator?: GCalPerson;
    attendees?: GCalAttendee[];
    responseStatus?: GCalResponseStatus;
    eventType?: GCalEventType;
    meetingLink?: string;
    location?: string;
    htmlLink?: string;
};
function pickGCalOwnedRoutineFields(source: GCalOwnedRoutineSource): Partial<Pick<RoutineInterface, (typeof GCAL_OWNED_ROUTINE_KEYS)[number]>> {
    return {
        ...(source.organizer !== undefined ? { organizer: source.organizer } : {}),
        ...(source.creator !== undefined ? { creator: source.creator } : {}),
        ...(source.attendees !== undefined ? { attendees: source.attendees } : {}),
        ...(source.responseStatus !== undefined ? { responseStatus: source.responseStatus } : {}),
        ...(source.eventType !== undefined ? { eventType: source.eventType } : {}),
        ...(source.meetingLink !== undefined ? { meetingLink: source.meetingLink } : {}),
        ...(source.location !== undefined ? { location: source.location } : {}),
        ...(source.htmlLink !== undefined ? { htmlLink: source.htmlLink } : {}),
    };
}
const pickGCalOwnedExceptionFields = pickGCalOwnedRoutineFields;

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

/** Routine-surface twin of `clearOmittedGCalOwnedFields`. Same semantics, RoutineInterface shape. */
function clearOmittedGCalOwnedRoutineFields(merged: RoutineInterface, event: CalendarEvent): RoutineInterface {
    const next: RoutineInterface = { ...merged };
    for (const key of GCAL_OWNED_ROUTINE_KEYS) {
        if (event[key] === undefined) {
            delete next[key];
        }
    }
    return next;
}

/** True iff the inbound event reports a different GCal-owned value on the routine surface. */
function hasGCalOwnedRoutineDelta(existing: RoutineInterface, event: CalendarEvent): boolean {
    return GCAL_OWNED_ROUTINE_KEYS.some((key) => JSON.stringify(existing[key]) !== JSON.stringify(event[key]));
}

/**
 * Applies a GCal-owned-only update to a routine via targeted $set/$unset. Used when GCal's webhook
 * arrives older than the local updatedTs but a GCal-owned field still diverges. Avoids the
 * read→merge→replaceById race window used by the structural-update path: writes only the
 * GCal-owned keys (GCAL_OWNED_ROUTINE_KEYS) (and bumps updatedTs) without touching anything the client owns.
 *
 * Also propagates the new master values onto existing items via `propagateMasterGCalOwnedChangesToItems`.
 */
async function applyGCalOwnedRoutineDeltaOnly(existing: RoutineInterface, event: CalendarEvent, ctx: SyncContext): Promise<void> {
    const routineId = existing._id;
    // Anchor `updatedTs` on `event.updated`, NOT ctx.now, so a future structural-newer event whose
    // `event.updated` falls between `existing.updatedTs` and `ctx.now` is not locked out by this
    // older-webhook fast-path bumping the local clock past the real GCal-side timestamp.
    const setOps: Record<string, unknown> = { updatedTs: event.updated };
    const unsetOps: Record<string, ''> = {};
    for (const key of GCAL_OWNED_ROUTINE_KEYS) {
        const value = event[key];
        if (value === undefined) {
            unsetOps[key] = '';
        } else {
            setOps[key] = value;
        }
    }
    const updateDoc: { $set: Record<string, unknown>; $unset?: Record<string, ''> } = { $set: setOps };
    if (Object.keys(unsetOps).length > 0) {
        updateDoc.$unset = unsetOps;
    }
    await routinesDAO.updateOne({ _id: routineId, user: ctx.userId }, updateDoc);
    const updated = await routinesDAO.findByOwnerAndId(routineId, ctx.userId);
    if (!updated) {
        return;
    }
    ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'routine', entityId: routineId, snapshot: updated, opType: 'update', now: ctx.now }));
    await propagateMasterGCalOwnedChangesToItems(updated, ctx);
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
 * True when the structural fields (title / time / all-day) on the incoming event actually differ
 * from the existing local item. Used to distinguish "GCal's `updated` advanced but the synced
 * content is byte-identical" (a content no-op — silently advance the anchor, no op recorded) from
 * a real edit. Without this gate, GCal bumping `event.updated` for non-synced reasons (reminders,
 * ACL changes, our own done-marker echo) re-applies an identical write on every webhook fire,
 * recording an op and firing a web push each time — the staging notification storm.
 *
 * `incomingTitle` is the title after done-marker stripping (the caller's `existing.status === 'done'`
 * normalization), so a done item whose only GCal-side delta is the "✓ " prefix counts as no-change.
 */
function hasStructuralDelta(existing: ItemInterface, event: CalendarEvent, incomingTitle: string): boolean {
    return (
        existing.title !== incomingTitle ||
        existing.timeStart !== event.timeStart ||
        existing.timeEnd !== event.timeEnd ||
        Boolean(existing.allDay) !== Boolean(event.allDay)
    );
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
    // is treated as past. New past events (no existing item) are ignored — we don't import history.
    // But an existing item moved into the past is synced like any other update (the user just
    // rescheduled it backwards); see `applyPastEventToExisting`.
    // Routine-managed items are preserved (the routine path owns their lifecycle).
    // Skip strong-key restore for past events: a *new* past event short-circuits to a no-op here, so
    // restoring an item we'd then ignore is a wasted op + flap.
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
        // Re-stamp BOTH link fields — see updateExistingCalendarItem for the disconnect+reconnect rationale.
        calendarIntegrationId: source.integration._id,
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
 * - no local item: nothing to do (new past events are not imported)
 * - routine-managed or already-trashed: skip (routine path owns lifecycle / no-op)
 * - any other existing item: normal field-level merge — the user just rescheduled it
 *   backwards, so it's synced like any other GCal update (regardless of status).
 */
async function applyPastEventToExisting(existing: ItemInterface | undefined, event: CalendarEvent, source: CalendarSource, ctx: SyncContext): Promise<void> {
    if (!existing || existing.routineId || existing.status === 'trash') {
        return;
    }
    // An item that already exists in GTD is synced wherever the user moves it on GCal — including
    // into the past. We used to trash a live `calendar` item dragged before today; that surprised
    // users who simply rescheduled an event backwards. New past events (no existing item) are still
    // ignored — that filtering happens in the caller, which only routes through here when `existing`
    // is present.
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

    // Sync layer owns the "✓ " done marker on GCal — strip it on inbound only when this item is
    // already done locally. For an open item, a user-typed "✓ " in GCal must be preserved verbatim.
    const incomingTitle = existing.status === 'done' ? stripDoneMarker(event.title) : event.title;

    // Content no-op: GCal's `updated` advanced (structurallyNewer) but no synced field actually
    // changed. Advancing `lastSyncedFromGCalTs` quietly — without a replaceById op or a ctx.ops
    // entry — re-anchors the echo guard so the next fire short-circuits, and avoids recording an
    // identical-snapshot op that would fan out a web push. This is the primary fix for the staging
    // notification storm (see hasStructuralDelta). Only reachable when structurallyNewer is the
    // sole trigger; notes/owned deltas fall through to the real merge below.
    if (structurallyNewer && !notesUpdate && !gcalOwnedChanged && !hasStructuralDelta(existing, event, incomingTitle)) {
        console.log(
            `[debug-gcal-sync][server] updateExistingCalendarItem content-noop — advancing anchor only | eventId=${event.id} eventUpdated=${event.updated}`,
        );
        await itemsDAO.updateOne({ _id: itemId, user: ctx.userId }, { $set: { lastSyncedFromGCalTs: event.updated } });
        return;
    }

    console.log(
        `[debug-gcal-sync][server] updateExistingCalendarItem applying | eventId=${event.id} structurallyNewer=${structurallyNewer} notesUpdate=${!!notesUpdate} gcalOwnedChanged=${gcalOwnedChanged}`,
    );

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
        // Always refresh link ids from the live source — symmetric with the always-overwritten
        // gcal-owned fields below. Gating this on `structurallyNewer` would leave a stale
        // `calendarIntegrationId` after a disconnect+reconnect when only notes or gcal-owned
        // fields changed; pushback would then silently no-op in resolvePushContext.
        calendarIntegrationId: source.integration._id,
        calendarSyncConfigId: source.config._id,
        ...(structurallyNewer
            ? {
                  title: incomingTitle,
                  timeStart: event.timeStart,
                  timeEnd: event.timeEnd,
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
    try {
        await itemsDAO.insertOne(newItem);
    } catch (err) {
        // The unique partial index (uniq_calendar_item_per_event) makes a second live calendar item on
        // the same (user, calendarEventId) impossible. A concurrent inbound sync (manual racing a
        // webhook) that already created the live item makes us the race loser — re-resolve and merge
        // into that one instead of duplicating. Mirrors the routine-side pattern in createRoutineFromGCal.
        if (isDuplicateKeyError(err)) {
            // Re-resolve the LIVE winner specifically: the conflicting index is partial on
            // status:'calendar', and a trash/done twin legitimately keeps its calendarEventId (for
            // revive). `findCalendarItemByEventId` has no status filter and could return that dead twin,
            // which updateExistingCalendarItem would no-op-merge into — silently dropping this event.
            // Match the index predicate so we only ever merge into the row that actually holds the key.
            const [winner] = await itemsDAO.findArray({ user: ctx.userId, calendarEventId: event.id, status: 'calendar' });
            if (winner) {
                console.warn(`[gcal-sync] createNewCalendarItem raced E11000 — updating existing item | eventId=${event.id} itemId=${winner._id}`);
                await updateExistingCalendarItem(winner, event, source, ctx);
                return;
            }
        }
        throw err;
    }
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
        // Per-instance GCal-owned overrides — only set when the parser detected divergence from the master.
        ...(ex.organizer !== undefined ? { organizer: ex.organizer } : {}),
        ...(ex.creator !== undefined ? { creator: ex.creator } : {}),
        ...(ex.attendees !== undefined ? { attendees: ex.attendees } : {}),
        ...(ex.responseStatus !== undefined ? { responseStatus: ex.responseStatus } : {}),
        ...(ex.eventType !== undefined ? { eventType: ex.eventType } : {}),
        ...(ex.meetingLink !== undefined ? { meetingLink: ex.meetingLink } : {}),
        ...(ex.location !== undefined ? { location: ex.location } : {}),
        ...(ex.htmlLink !== undefined ? { htmlLink: ex.htmlLink } : {}),
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
    ctx: SyncContext,
    query: { filter: Record<string, unknown>; setFields: Record<string, unknown>; unsetFields?: Record<string, ''> },
): Promise<void> {
    const before = await itemsDAO.findArray(query.filter);
    const ids = before.map((item) => item._id).filter((id): id is string => Boolean(id));
    if (!hasAtLeastOne(ids)) {
        return;
    }
    // `unsetFields` lets trash call sites release `calendarInstanceEventId` so the freed id no longer
    // occupies the presence-partial `(user, calendarInstanceEventId)` unique index — otherwise a
    // replacement routine on the same GCal series (split successor / reconnect re-import) can't
    // regenerate that occurrence (silent E11000 in insertFreshOccurrence → invisible series).
    const updateDoc = query.unsetFields ? { $set: query.setFields, $unset: query.unsetFields } : { $set: query.setFields };
    await itemsDAO.updateMany(query.filter, updateDoc);
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

/**
 * Returns true if a `modified` exception's effective date is strictly before today in the
 * calendar's timezone. Used to short-circuit orphan-create for ancient exceptions surfaced by a
 * fresh reconnect.
 *
 * Compares `YYYY-MM-DD` strings rather than parsed timestamps. `ex.originalDate` is a date-only
 * `YYYY-MM-DD` (`dayjs(date)` parses it as `T00:00:00Z` regardless of zone), so an ISO datetime
 * comparison against `startOfDay` for a TZ east of UTC would mis-flag a "today, all-day in TZ"
 * exception as past. `newTimeStart` falls back to `newTimeEnd` so a reschedule that carried only
 * the new end (theoretically possible per the `GCalException` type, even though the current parser
 * always sets both) isn't dropped.
 */
function isExceptionBeforeToday(ex: GCalException, ctx: SyncContext): boolean {
    const tz = ctx.timeZone ?? 'UTC';
    const todayInTz = dayjs(ctx.now).tz(tz).format('YYYY-MM-DD');
    // Both date-only and date-time values normalize to YYYY-MM-DD via `slice(0, 10)` — using
    // `dayjs.format` on a UTC-suffixed datetime would shift the calendar date when the runner's
    // local zone differs. GCal returns instance `start.dateTime` in the event's own offset, so
    // its first 10 chars match the calendar's wall-clock date for that occurrence.
    const effective = ex.newTimeStart ?? ex.newTimeEnd ?? ex.originalDate;
    const effectiveDate = effective.length >= 10 ? effective.slice(0, 10) : effective;
    return effectiveDate < todayInTz;
}

/** Applies a single GCal exception's side effects to the items collection. */
export async function applyExceptionToItems(routine: RoutineInterface, ex: GCalException, ctx: SyncContext): Promise<void> {
    if (!ISO_DATE_RE.test(ex.originalDate)) {
        return;
    }
    const target = await resolveExceptionTarget(routine, ex, ctx.userId);

    if (ex.type === 'deleted') {
        // No create-on-miss for deletes — there's nothing to delete if no item matches. Free the
        // instance id too: the occurrence is gone from GCal, so its id must not keep the index slot.
        await updateItemsAndRecordOps(ctx, {
            filter: target.filter,
            setFields: { status: 'trash', updatedTs: ctx.now },
            unsetFields: { calendarInstanceEventId: '' },
        });
        return;
    }

    if (ex.type === 'modified') {
        const sharedFields = {
            updatedTs: ctx.now,
            ...(ex.newTimeStart ? { timeStart: ex.newTimeStart } : {}),
            ...(ex.newTimeEnd ? { timeEnd: ex.newTimeEnd } : {}),
            // ex.notes is raw HTML from GCal — convert to markdown for storage, keep HTML as lastSyncedNotes
            ...(ex.notes !== undefined ? { notes: htmlToMarkdown(ex.notes), lastSyncedNotes: ex.notes } : {}),
            // Per-instance GCal-owned overrides win over the master values that buildCalendarItem
            // already mirrored onto the item. Absent on the exception ⇒ instance inherits master
            // and the item's mirrored value (which was set from master) stays put.
            ...(ex.organizer !== undefined ? { organizer: ex.organizer } : {}),
            ...(ex.creator !== undefined ? { creator: ex.creator } : {}),
            ...(ex.attendees !== undefined ? { attendees: ex.attendees } : {}),
            ...(ex.responseStatus !== undefined ? { responseStatus: ex.responseStatus } : {}),
            ...(ex.eventType !== undefined ? { eventType: ex.eventType } : {}),
            ...(ex.meetingLink !== undefined ? { meetingLink: ex.meetingLink } : {}),
            ...(ex.location !== undefined ? { location: ex.location } : {}),
            ...(ex.htmlLink !== undefined ? { htmlLink: ex.htmlLink } : {}),
        };
        if (hasAtLeastOne(target.matches)) {
            await applyModifiedExceptionToMatches(target.matches, ex, sharedFields, ctx);
            return;
        }
        // Past-cutoff guard: on a fresh reconnect (lastSyncedTs unset), GCal returns every modified
        // instance since 1970 — yearly-birthday routines with old `* […]` exceptions would otherwise
        // materialize as ancient calendar items via the orphan path. Mirrors the
        // `startOfTodayInTz`/`isPastEvent` guard used for standalone events in `upsertCalendarItem`.
        if (isExceptionBeforeToday(ex, ctx)) {
            console.log(`[gcal-sync] applyExceptionToItems: skipped past-cutoff exception | routineId=${routine._id} date=${ex.originalDate}`);
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
        // Scope to `status: 'calendar'` for the same reason as the fallback: `done`/`trash` rows
        // legitimately retain `calendarInstanceEventId` for echo matching and history, but they
        // must not absorb a fresh modified-exception (which would silently revive their times
        // while leaving them invisible in the UI). The squat is resolved downstream in
        // `createItemForOrphanedException` via dead-twin demote when necessary.
        const preferred = { user: userId, calendarInstanceEventId: ex.googleEventId, status: 'calendar' } as const;
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

/**
 * True iff applying `setFields` (minus the always-present `updatedTs` bump) and removing `unsetFields`
 * leaves the item structurally unchanged. Lets the exception-apply path skip the write + op when an
 * inbound modified-exception carries the same values the item already holds — the per-item analogue
 * of the `routineExceptions` deep-equal guard in `syncRoutineExceptions`.
 */
function isItemUpdateNoop(item: ItemInterface, setFields: Record<string, unknown>, unsetFields: Record<string, ''>): boolean {
    if (Object.keys(unsetFields).length > 0) {
        // An unset only happens when the item currently carries that key (guarded at the call site),
        // so any pending unset is by definition a real change.
        return false;
    }
    const { updatedTs: _ignored, ...meaningfulSetFields } = setFields;
    return Object.entries(meaningfulSetFields).every(([key, value]) => stableStringify(item[key as keyof ItemInterface]) === stableStringify(value));
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
    // GCal-owned keys absent on the exception ⇒ instance inherits master per RFC 5545. Any keys the
    // item carried as a prior per-instance override must be explicitly unset so the regenerator can
    // re-mirror the master values; otherwise a "removed an attendee, reverted to master" GCal edit
    // would leave the item stuck on the stale 3-attendee override.
    const unsetFields: Record<string, ''> = {};
    for (const key of GCAL_OWNED_ROUTINE_KEYS) {
        if (ex[key] === undefined && item[key] !== undefined) {
            unsetFields[key] = '';
        }
    }
    // No-op guard: `getExceptions` is a time-range (not incremental) query, so every webhook fire
    // re-surfaces the same modified instances. Without this, each fire rewrote the matched item with
    // an identical snapshot (only `updatedTs` differs) and emitted a redundant `update` op — flooding
    // the operations log and spamming web push. Skip when the projected next-state equals the current
    // item ignoring `updatedTs` (the routine `routineExceptions` write has the symmetric guard).
    if (isItemUpdateNoop(item, setFields, unsetFields)) {
        return;
    }
    const update = Object.keys(unsetFields).length > 0 ? { $set: setFields, $unset: unsetFields } : { $set: setFields };
    // Conditional on `updatedTs` — a concurrent /sync/push edit landing between resolve and apply
    // would change `updatedTs`; matchedCount === 0 means we lost the race and must not clobber.
    const result = await itemsDAO.updateOne({ _id: itemId, user: ctx.userId, updatedTs: item.updatedTs } as never, update);
    if (result.matchedCount === 0) {
        console.log(`[gcal-sync] applyModifiedExceptionToOne: skipped due to concurrent updatedTs bump | itemId=${itemId}`);
        return;
    }
    // Re-read so the recorded op snapshot reflects the post-$unset state. Building it locally via
    // `{ ...item, ...setFields }` would carry stale unset keys forward and confuse downstream sync.
    const refreshed = await itemsDAO.findByOwnerAndId(itemId, ctx.userId);
    if (!refreshed) {
        return;
    }
    ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'item', entityId: itemId, snapshot: refreshed, opType: 'update', now: ctx.now }));
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
    // Per-instance overrides (if present) win over the routine's master values; otherwise the
    // master values inherit so the orphan-created item shows the same attendees / organizer / etc.
    // as every other generated occurrence.
    const inheritedGCalOwned = pickGCalOwnedRoutineFields(routine);
    const overrideGCalOwned = pickGCalOwnedExceptionFields(ex);
    const mergedGCalOwned = { ...inheritedGCalOwned, ...overrideGCalOwned };
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
        ...(derived.allDay === true ? { allDay: true as const } : {}),
        ...(routine.calendarIntegrationId ? { calendarIntegrationId: routine.calendarIntegrationId } : {}),
        ...(routine.calendarSyncConfigId ? { calendarSyncConfigId: routine.calendarSyncConfigId } : {}),
        ...(ex.googleEventId ? { calendarInstanceEventId: ex.googleEventId } : {}),
        ...(ex.notes !== undefined ? { notes: htmlToMarkdown(ex.notes), lastSyncedNotes: ex.notes } : {}),
        ...mergedGCalOwned,
        createdTs: ctx.now,
        updatedTs: ctx.now,
    };
    try {
        await itemsDAO.insertOne(item);
    } catch (err) {
        if (isDuplicateKeyError(err)) {
            await handleOrphanInsertDuplicate(routine, ex, { item, itemId }, ctx);
            return;
        }
        throw err;
    }
    ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'item', entityId: itemId, snapshot: item, opType: 'create', now: ctx.now }));
    console.log(
        `[gcal-sync] applyExceptionToItems: created orphan-exception item | routineId=${routine._id} itemId=${itemId} googleEventId=${ex.googleEventId ?? 'n/a'}`,
    );
}

/**
 * Two scenarios collapse the unique partial index `(user, calendarInstanceEventId)` onto our insert:
 *  1. Live race winner — another inbound sync just inserted a fresh `calendar` row for this instance.
 *     Re-resolve and patch the winner's row so both callers converge.
 *  2. Dead twin on a different routine — a `trash`/`done` row left over from a paused-and-resumed or
 *     disconnect-and-reconnect cycle is still squatting the slot. Demote (strip its
 *     `calendarInstanceEventId`) so the slot frees up, then retry the insert.
 */
async function handleOrphanInsertDuplicate(
    routine: RoutineInterface,
    ex: GCalException,
    pending: { item: ItemInterface; itemId: string },
    ctx: SyncContext,
): Promise<void> {
    if (!ex.googleEventId) {
        // No instance id ⇒ index can't have been the source of the conflict — defer to the existing race-loser path.
        await applyExceptionAfterDuplicate(routine, ex, ctx);
        return;
    }
    const conflicting = await itemsDAO.findOne({ user: ctx.userId, calendarInstanceEventId: ex.googleEventId } as never);
    if (!conflicting || !isDemotableDeadTwin(conflicting, routine._id)) {
        await applyExceptionAfterDuplicate(routine, ex, ctx);
        return;
    }
    await demoteDeadTwinAndRetryInsert(conflicting, pending, ctx);
}

/** A `trash`/`done` row on a foreign routine is stale enough that we can safely strip its instance id to free the slot. */
function isDemotableDeadTwin(conflicting: ItemInterface, currentRoutineId: string): boolean {
    const isDead = conflicting.status === 'trash' || conflicting.status === 'done';
    const isForeignRoutine = conflicting.routineId !== currentRoutineId;
    return isDead && isForeignRoutine;
}

async function demoteDeadTwinAndRetryInsert(conflicting: ItemInterface, pending: { item: ItemInterface; itemId: string }, ctx: SyncContext): Promise<void> {
    const conflictingId = conflicting._id;
    if (!conflictingId) {
        return;
    }
    await itemsDAO.updateOne({ _id: conflictingId, user: ctx.userId } as never, { $unset: { calendarInstanceEventId: '' }, $set: { updatedTs: ctx.now } });
    // Re-read so the recorded op carries the post-$unset snapshot; building locally would leak the stripped id back into the log.
    const refreshed = await itemsDAO.findByOwnerAndId(conflictingId, ctx.userId);
    if (refreshed) {
        ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'item', entityId: conflictingId, snapshot: refreshed, opType: 'update', now: ctx.now }));
    }
    const { item, itemId } = pending;
    try {
        await itemsDAO.insertOne(item);
    } catch (err) {
        if (isDuplicateKeyError(err)) {
            // Another writer raced in between our demote and retry — bail rather than loop. Next sync re-converges.
            console.warn(
                `[gcal-sync] createItemForOrphanedException: second insert raced E11000 | routineId=${item.routineId} eventId=${item.calendarInstanceEventId}`,
            );
            return;
        }
        throw err;
    }
    ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'item', entityId: itemId, snapshot: item, opType: 'create', now: ctx.now }));
    console.log(
        `[gcal-sync] applyExceptionToItems: demoted dead twin + created orphan-exception item | routineId=${item.routineId} itemId=${itemId} demotedItemId=${conflictingId}`,
    );
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
        ...(ex.organizer !== undefined ? { organizer: ex.organizer } : {}),
        ...(ex.creator !== undefined ? { creator: ex.creator } : {}),
        ...(ex.attendees !== undefined ? { attendees: ex.attendees } : {}),
        ...(ex.responseStatus !== undefined ? { responseStatus: ex.responseStatus } : {}),
        ...(ex.eventType !== undefined ? { eventType: ex.eventType } : {}),
        ...(ex.meetingLink !== undefined ? { meetingLink: ex.meetingLink } : {}),
        ...(ex.location !== undefined ? { location: ex.location } : {}),
        ...(ex.htmlLink !== undefined ? { htmlLink: ex.htmlLink } : {}),
    };
    await applyModifiedExceptionToMatches(target.matches, ex, sharedFields, ctx);
}

/** Picks `timeStart`/`timeEnd` for an orphan-create from the exception's move times, falling back to the routine's regular schedule. */
function deriveExceptionItemTimes(routine: RoutineInterface, ex: GCalException): { timeStart: string; timeEnd: string; allDay?: boolean } | undefined {
    if (ex.newTimeStart && ex.newTimeEnd) {
        return { timeStart: ex.newTimeStart, timeEnd: ex.newTimeEnd };
    }
    const template = routine.calendarItemTemplate;
    if (!template) {
        return undefined;
    }
    if (template.allDay === true) {
        // All-day fallback: synthesize a single-day range from the rrule date. GCal exclusive-end → +1 day.
        return { timeStart: ex.originalDate, timeEnd: dayjs(ex.originalDate).add(1, 'day').format('YYYY-MM-DD'), allDay: true };
    }
    const { timeOfDay, duration } = template;
    if (timeOfDay === undefined || duration === undefined) {
        // Misconfigured timed template — nothing to fall back to.
        return undefined;
    }
    const timeStart = `${ex.originalDate}T${timeOfDay}:00`;
    const timeEnd = dayjs(timeStart).add(duration, 'minute').format('YYYY-MM-DDTHH:mm:ss');
    return { timeStart, timeEnd };
}

/**
 * Reverts a single routine item back to its master rrule time and clears any per-instance overrides.
 * Called when a `modified` exception is reconciled away (GCal stopped reporting the instance as
 * overridden). Reuses the regular modified-exception apply machinery by synthesizing a bare
 * exception (only `originalDate`): `deriveExceptionItemTimes` then yields the master template time,
 * and `applyModifiedExceptionToOne`'s `isItemUpdateNoop` guard makes it a no-op if already reverted.
 */
async function revertItemToMasterTime(routine: RoutineInterface, date: string, ctx: SyncContext): Promise<void> {
    const bareException: GCalException = { originalDate: date, type: 'modified' };
    const masterTimes = deriveExceptionItemTimes(routine, bareException);
    if (!masterTimes) {
        console.warn(`[gcal-sync] reconcileRemovedExceptions: cannot derive master time to revert | routineId=${routine._id} date=${date}`);
        return;
    }
    const { matches } = await resolveExceptionTarget(routine, bareException, ctx.userId);
    if (!hasAtLeastOne(matches)) {
        return;
    }
    // sharedFields carries the master time + allDay; applyModifiedExceptionToOne also unsets any
    // GCal-owned per-instance overrides the item still holds, restoring full master inheritance.
    const sharedFields = { ...masterTimes, updatedTs: ctx.now };
    await applyModifiedExceptionToMatches(matches, bareException, sharedFields, ctx);
}

/**
 * Removes local `modified` exceptions that GCal no longer reports as overridden instances, reverting
 * each affected item back to its master rrule time. Returns the reconciled exception list (a subset
 * of the routine's current exceptions) for the caller to merge fresh GCal exceptions into.
 *
 * Window: only exceptions whose date falls within `getExceptions`' own query window
 * (`[now-30d, now+1y]`) are eligible for removal. An exception older or further out than that window
 * is never reported by `getExceptions` regardless of whether it's still a real override, so deleting
 * it on absence would wrongly drop a still-valid exception.
 *
 * Scope: only `modified` exceptions that are a pure TIME move (`newTimeStart` set) are reconciled.
 * A time override's absence from `getExceptions` genuinely means the instance is back at master time
 * (the reported bug). A title/notes/owned-only override is deliberately left alone — `getExceptions`
 * suppresses content exceptions that match the master (RFC 5545 inheritance), so absence there is
 * ambiguous and must not trigger a revert that would clobber a still-valid per-instance title/notes.
 * `skipped` (GCal-deleted) instances are out of scope HERE — their symmetric revival reconciliation
 * lives in `reconcileRevivedSkippedExceptions`, which runs immediately after this in `syncRoutineExceptions`.
 */
/**
 * Computes the `calendarInstanceEventId` a revived occurrence should carry, mirroring what the
 * routine generator (`buildCalendarItem`) mints. Returns undefined for an in-app (non-GCal) routine
 * or when the timed-template fields needed to derive the suffix are missing — the revival then
 * proceeds without an instance id (the next inbound sync re-keys it).
 */
function buildRevivedInstanceEventId(routine: RoutineInterface, date: string, timeZone: string): string | undefined {
    if (!routine.calendarEventId) {
        return undefined;
    }
    const template = routine.calendarItemTemplate;
    const occurrenceDate = dayjs.utc(date).toDate();
    if (template?.allDay === true) {
        return buildCalendarInstanceEventId(routine.calendarEventId, occurrenceDate, undefined, timeZone);
    }
    if (template?.timeOfDay === undefined) {
        return undefined;
    }
    return buildCalendarInstanceEventId(routine.calendarEventId, occurrenceDate, template.timeOfDay, timeZone);
}

/**
 * Revives a routine occurrence whose `skipped` exception GCal stopped reporting as cancelled — the
 * inverse of `revertItemToMasterTime`. The occurrence is back on GCal (the cancellation tombstone
 * disappeared), so the local item must return to `status: 'calendar'` at master time.
 *
 * Prefers an in-place flip of the still-present trashed row (preserves the item id + sync history);
 * the trash path `$unset` its `calendarInstanceEventId`, so we re-mint a valid one here to re-key the
 * occurrence and re-occupy the `(user, calendarInstanceEventId)` unique partial index. When no trashed
 * row survives (purged, or its `timeStart` was shifted by a prior move so it no longer sits at the
 * master date), fall back to the orphan-create path, which mints a fresh master-time row and resolves
 * any index collision via the existing dead-twin demote machinery.
 */
async function reviveSkippedOccurrence(routine: RoutineInterface, date: string, ctx: SyncContext): Promise<void> {
    const bareException: GCalException = { originalDate: date, type: 'modified' };
    const masterTimes = deriveExceptionItemTimes(routine, bareException);
    if (!masterTimes) {
        console.warn(`[gcal-sync] reviveSkippedOccurrence: cannot derive master time to revive | routineId=${routine._id} date=${date}`);
        return;
    }
    const nextDay = dayjs(date).add(1, 'day').format('YYYY-MM-DD');
    const trashedFilter = { user: ctx.userId, routineId: routine._id, status: 'trash', timeStart: { $gte: date, $lt: nextDay } } as const;
    const trashed = await itemsDAO.findArray(trashedFilter);
    // First match wins; any stragglers (legacy duplicate-bug residue) stay trashed — harmless.
    const target = trashed.find((item) => Boolean(item._id));
    if (!target?._id) {
        // No trashed row at the master date — recreate from scratch at master time.
        const instanceEventId = buildRevivedInstanceEventId(routine, date, ctx.timeZone ?? 'UTC');
        await createItemForOrphanedException(routine, { ...bareException, ...(instanceEventId ? { googleEventId: instanceEventId } : {}) }, ctx);
        return;
    }
    await reviveTrashedRoutineItemInPlace(routine, { item: target, itemId: target._id }, { masterTimes, date }, ctx);
}

/** The occurrence-specific inputs a revival writes: the rrule date and the master-template times to land on. */
type RevivalTarget = { masterTimes: { timeStart: string; timeEnd: string; allDay?: boolean }; date: string };

/**
 * Flips a single trashed routine item back to `status: 'calendar'` at master time, re-minting its
 * `calendarInstanceEventId` and clearing the `cancelledByGCal` badge. Conditional on the row's
 * `updatedTs` so a concurrent `/sync/push` edit between resolve and write isn't clobbered.
 */
async function reviveTrashedRoutineItemInPlace(
    routine: RoutineInterface,
    pending: { item: ItemInterface; itemId: string },
    revival: RevivalTarget,
    ctx: SyncContext,
): Promise<void> {
    const { item, itemId } = pending;
    const { masterTimes, date } = revival;
    const instanceEventId = buildRevivedInstanceEventId(routine, date, ctx.timeZone ?? 'UTC');
    const setFields: Record<string, unknown> = {
        status: 'calendar',
        timeStart: masterTimes.timeStart,
        timeEnd: masterTimes.timeEnd,
        ...(masterTimes.allDay === true ? { allDay: true } : {}),
        ...(instanceEventId ? { calendarInstanceEventId: instanceEventId } : {}),
        updatedTs: ctx.now,
    };
    // Clear the "Cancelled in Calendar" badge a GCal-driven trash may have stamped, and drop a stale
    // all-day flag if the revived master time is timed. `$set` alone can't remove keys.
    const unsetFields: Record<string, ''> = {
        ...(item.cancelledByGCal !== undefined ? { cancelledByGCal: '' as const } : {}),
        ...(masterTimes.allDay !== true && item.allDay !== undefined ? { allDay: '' as const } : {}),
    };
    const update = Object.keys(unsetFields).length > 0 ? { $set: setFields, $unset: unsetFields } : { $set: setFields };
    // Conditional on `updatedTs` — a concurrent /sync/push edit between resolve and apply would change
    // it; matchedCount === 0 means we lost the race and must not clobber. Next sync re-resolves.
    let result: { matchedCount: number };
    try {
        result = await itemsDAO.updateOne({ _id: itemId, user: ctx.userId, updatedTs: item.updatedTs } as never, update);
    } catch (err) {
        if (isDuplicateKeyError(err) && instanceEventId) {
            // A dead twin (trash/done row from a reconnect/split) still squats the re-minted instance id.
            // The orphan-create path owns the full dead-twin demote machinery — delegate to it.
            console.warn(
                `[gcal-sync] reviveTrashedRoutineItemInPlace: re-mint hit E11000, delegating to orphan-create | itemId=${itemId} instanceId=${instanceEventId}`,
            );
            await createItemForOrphanedException(routine, { originalDate: date, type: 'modified', googleEventId: instanceEventId }, ctx);
            return;
        }
        throw err;
    }
    if (result.matchedCount === 0) {
        console.log(`[gcal-sync] reviveTrashedRoutineItemInPlace: skipped due to concurrent updatedTs bump | itemId=${itemId}`);
        return;
    }
    const refreshed = await itemsDAO.findByOwnerAndId(itemId, ctx.userId);
    if (!refreshed) {
        return;
    }
    ctx.ops.push(await recordOperation(ctx.userId, { entityType: 'item', entityId: itemId, snapshot: refreshed, opType: 'update', now: ctx.now }));
    console.log(
        `[gcal-sync] reviveTrashedRoutineItemInPlace: revived trashed routine item to master time | routineId=${refreshed.routineId} itemId=${itemId} date=${date}`,
    );
}

/**
 * Removes local `skipped` exceptions that GCal no longer reports as cancelled instances, reviving each
 * affected occurrence's item to master time. The symmetric sibling of `reconcileRemovedExceptions`:
 * `getExceptions` (`singleEvents: true, showDeleted: true`) reports a date as `deleted` only while the
 * GCal cancellation tombstone exists; once the user un-deletes / recreates that occurrence the tombstone
 * disappears, so the date's absence from the reported deleted set means "the occurrence is back."
 *
 * Provenance is NOT a concern: an in-app trash of a routine instance pushes `cancelRecurringInstance`
 * to GCal (`pushRoutineInstanceCancellation`), so EVERY `skipped` exception corresponds to a real GCal
 * tombstone regardless of whether the user deleted in-app or in GCal. The tombstone vanishing is the
 * authoritative "back" signal either way.
 *
 * Guards (each mirrors `reconcileRemovedExceptions`, with one addition):
 *  - Window: only `skipped` exceptions inside `getExceptions`' real query window
 *    (`max(since, now-30d) < date < now+1y`, strictly exclusive on both date boundaries to drop the
 *    date-vs-instant truncation slivers) are eligible — an out-of-window date is never reported, so its
 *    absence is meaningless.
 *  - GCal truth: the master rrule must still generate the occurrence. A `skipped` date can also vanish
 *    from `getExceptions` because the master recurrence changed (e.g. capped by UNTIL on pause) so the
 *    occurrence no longer exists at all — reviving it then would resurrect a phantom. `routineGenerates-
 *    OccurrenceOnDate` reads the raw rrule (ignoring exceptions) to confirm the occurrence is real.
 */
async function reconcileRevivedSkippedExceptions(
    routine: RoutineInterface,
    existing: RoutineException[],
    reported: GCalException[],
    since: string,
    ctx: SyncContext,
): Promise<RoutineException[]> {
    if (!hasAtLeastOne(existing)) {
        return existing;
    }
    // Identical window derivation to reconcileRemovedExceptions — see its comment for the
    // strict-exclusive boundary rationale (date-vs-ISO-instant truncation slivers at each edge).
    const floor = dayjs(ctx.now).subtract(30, 'day');
    const floorDate = (dayjs(since).isAfter(floor) ? dayjs(since) : floor).format('YYYY-MM-DD');
    const windowEnd = dayjs(ctx.now).add(1, 'year').format('YYYY-MM-DD');
    const reportedDeletedDates = new Set(reported.filter((ex) => ex.type === 'deleted').map((ex) => ex.originalDate));
    const isInWindow = (d: string) => d > floorDate && d < windowEnd;

    const isRevivable = (ex: RoutineException) =>
        ex.type === 'skipped' && isInWindow(ex.date) && !reportedDeletedDates.has(ex.date) && routineGeneratesOccurrenceOnDate(routine, ex.date);
    const revivable = existing.filter(isRevivable);
    if (!hasAtLeastOne(revivable)) {
        return existing;
    }
    console.log(
        `[gcal-sync] reconcileRevivedSkippedExceptions: reviving ${revivable.length} restored occurrence(s) | routineId=${routine._id} dates=${revivable.map((e) => e.date).join(',')}`,
    );
    await Promise.all(revivable.map((ex) => reviveSkippedOccurrence(routine, ex.date, ctx)));
    const revivedDates = new Set(revivable.map((ex) => ex.date));
    return existing.filter((ex) => !revivedDates.has(ex.date));
}

async function reconcileRemovedExceptions(routine: RoutineInterface, reported: GCalException[], since: string, ctx: SyncContext): Promise<RoutineException[]> {
    const existing = routine.routineExceptions ?? [];
    if (!hasAtLeastOne(existing)) {
        return [];
    }
    // Window MUST mirror GoogleCalendarProvider.getExceptions' actual query bounds, NOT a hardcoded
    // now-30d. Its timeMin is max(since, now-30d): with a recent sync cursor, exceptions dated in
    // [now-30d, since) legitimately aren't returned because they predate the cursor — treating that
    // absence as "removed" would falsely revert + drop a still-valid time override (silent data loss).
    //
    // The provider's timeMin is a full ISO instant; we only have an exception's YYYY-MM-DD. An
    // instance ON the floor's calendar date but earlier-in-day than the floor instant is excluded by
    // the provider yet would round into a date-only window — the same data-loss class, one day wide.
    // Make BOTH bounds STRICTLY EXCLUSIVE of their own date (`floorDate < date < windowEnd`) to drop
    // the ambiguous boundary days at each end — timeMax (now+1y) is also a full instant anchored to
    // the current time-of-day, so an instance ON the now+1y date but later-in-day is excluded by the
    // provider yet would round into an inclusive `<=` window (the symmetric sliver). Cost is nil: the
    // revert bug concerns recent/future moves, not the exact 30-day-ago or 1-year-out boundary days.
    const floor = dayjs(ctx.now).subtract(30, 'day');
    const floorDate = (dayjs(since).isAfter(floor) ? dayjs(since) : floor).format('YYYY-MM-DD');
    const windowEnd = dayjs(ctx.now).add(1, 'year').format('YYYY-MM-DD');
    const reportedDates = new Set(reported.map((ex) => ex.originalDate));
    const isInWindow = (date: string) => date > floorDate && date < windowEnd;

    const isReconcilable = (ex: RoutineException) => ex.type === 'modified' && ex.newTimeStart !== undefined;
    const removable = existing.filter((ex) => isReconcilable(ex) && isInWindow(ex.date) && !reportedDates.has(ex.date));
    if (!hasAtLeastOne(removable)) {
        return existing;
    }
    console.log(
        `[gcal-sync] reconcileRemovedExceptions: reverting ${removable.length} stale modified exception(s) | routineId=${routine._id} dates=${removable.map((e) => e.date).join(',')}`,
    );
    // Revert each orphaned exception's item back to master time before dropping the exception.
    await Promise.all(removable.map((ex) => revertItemToMasterTime(routine, ex.date, ctx)));
    const removedDates = new Set(removable.map((ex) => ex.date));
    return existing.filter((ex) => !(isReconcilable(ex) && removedDates.has(ex.date)));
}

async function syncRoutineExceptions(routine: RoutineInterface, provider: GoogleCalendarProvider, ctx: RoutineSyncCtx): Promise<void> {
    if (!routine.calendarEventId) {
        return;
    }

    // Compare against lastSyncedNotes (raw HTML) since GCal returns HTML descriptions.
    // GCal-owned fields are passed through too so the parser can suppress no-op exception writes
    // when the instance attendee list / organizer / etc. match the master (RFC 5545 inheritance).
    const masterContent = {
        title: routine.title,
        description: routine.lastSyncedNotes ?? '',
        ...(routine.organizer ? { organizer: routine.organizer } : {}),
        ...(routine.creator ? { creator: routine.creator } : {}),
        ...(routine.attendees ? { attendees: routine.attendees } : {}),
        ...(routine.eventType ? { eventType: routine.eventType } : {}),
        ...(routine.meetingLink ? { meetingLink: routine.meetingLink } : {}),
        ...(routine.location ? { location: routine.location } : {}),
        ...(routine.htmlLink ? { htmlLink: routine.htmlLink } : {}),
    };
    const exceptions = await provider.getExceptions(routine.calendarEventId, ctx.calendarId, ctx.since, masterContent);

    console.log(`[gcal-sync] syncing routine exceptions | routineId=${routine._id} title=${routine.title} exceptionCount=${exceptions.length}`);

    const syncCtx: SyncContext = { userId: ctx.userId, now: ctx.now, ops: ctx.ops, ...(ctx.timeZone ? { timeZone: ctx.timeZone } : {}) };
    await reconcileAndApplyRoutineExceptions(routine, exceptions, ctx.since, syncCtx);
}

/**
 * The provider-agnostic core of `syncRoutineExceptions`: given the `reported` exception set GCal
 * returned for this series, reconcile both removal directions, apply each reported exception's item
 * side-effects, and persist the merged exception list. Exported so the dev-only
 * `/dev/calendar/simulate-routine-exception-sync` endpoint can drive the full reconcile path with a
 * controllable `reported` set (real `getExceptions` needs a live Google account).
 */
export async function reconcileAndApplyRoutineExceptions(routine: RoutineInterface, reported: GCalException[], since: string, ctx: SyncContext): Promise<void> {
    // Reconcile DELETIONS first: a local `modified` exception that GCal no longer reports as an
    // overridden instance (e.g. the user dragged an instance back to its master time, so GCal
    // dropped the override) must be removed and its item reverted to the master rrule time.
    // `getExceptions` only ever ADDS/updates — without this, the stale exception froze the item at
    // the moved time (the "nudged then moved back, app stuck at the old time" bug). Runs even when
    // `reported` is empty, which is exactly the revert-everything case.
    const reconciled = await reconcileRemovedExceptions(routine, reported, since, ctx);

    // Reconcile REVIVALS next (symmetric sibling): a local `skipped` exception that GCal no longer
    // reports as a cancelled instance means the occurrence was un-deleted / recreated on GCal — revive
    // the trashed item to master time and drop the `skipped` exception. Chained on `reconciled` (not
    // the routine) so both reconcilers' removals compose rather than clobber — they touch disjoint
    // exception types (`modified` vs `skipped`), so the merge of fresh exceptions below is unaffected.
    const afterRevival = await reconcileRevivedSkippedExceptions(routine, reconciled, reported, since, ctx);

    // Apply item side-effects in parallel — each exception targets a different date so there
    // are no write conflicts between them.
    const updatedExceptions = reported.reduce((acc, ex) => mergeExceptions(acc, ex), afterRevival);
    await Promise.all(reported.map((ex) => applyExceptionToItems(routine, ex, ctx)));

    // Skip the routine write + op when the merged exception set is byte-identical to what's stored.
    // `getExceptions` is a time-range (not incremental) query, so every webhook fire re-surfaces the
    // same exceptions and `mergeExceptions` reproduces an identical list — without this guard each
    // fire rewrote the routine and emitted a redundant `update` op, bloating the operations log (one
    // routine had 3000+ such ops). Item side-effects above are already idempotent on their own guards.
    if (stableStringify(updatedExceptions) === stableStringify(routine.routineExceptions ?? [])) {
        return;
    }

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
    // RSVP targets one specific GCal event. For single events that's item.calendarEventId; for
    // routine-generated instances it's item.calendarInstanceEventId (master id lives on the routine,
    // the instance id pins the per-occurrence event GCal returns in `instances.list`).
    const rsvpEventId = item.calendarEventId ?? item.calendarInstanceEventId;
    if (item.status !== 'calendar' || !rsvpEventId || !item.calendarIntegrationId) {
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
        await provider.patchEventAttendees(config.calendarId, rsvpEventId, nextAttendees, { sendUpdates: 'all' });
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
            calendarEventId: rsvpEventId,
            calendarIntegrationId: integration._id,
            responseStatus: body.responseStatus,
        },
        now,
    });

    return c.json(updated);
});

// ── Webhook watch management ─────────────────────────────────────────────────

/**
 * Stops a channel on Google's side, best-effort. Does NOT touch the config row — callers decide
 * whether to clear (teardown) or overwrite (re-register) the stored webhook fields. Extracted so
 * `setupWatch` can stop a stale channel before minting a new one without clearing fields it's about
 * to rewrite.
 */
async function stopChannelOnGoogle(
    channelId: string | undefined,
    resourceId: string | undefined,
    provider: GoogleCalendarProvider,
    integrationId: string,
): Promise<void> {
    if (!channelId || !resourceId) {
        return;
    }
    // Best-effort — the channel may have already expired or been invalidated.
    await withAuthFailureHandling(integrationId, () => provider.stopWatch(channelId, resourceId)).catch(() => {});
}

/**
 * Sets up a Google push notification channel for the given sync config. Stores webhook fields on
 * success. Idempotent: if the config already carries a channel (e.g. an enable→disable→enable
 * cycle, or a config row that survived a disconnect+reconnect), that channel is stopped on Google's
 * side first. Without this, each setup minted a fresh channel while leaving the old one live —
 * Google then delivered every change once per orphaned channel, multiplying webhook fan-out (the
 * orphaned-channel leak behind the staging notification storm).
 */
async function setupWatch(config: CalendarSyncConfigInterface, provider: GoogleCalendarProvider, integrationId: string): Promise<void> {
    // Webhook feature is opt-in: no-op when CALENDAR_WEBHOOK_URL is not configured.
    const webhookUrl = process.env.CALENDAR_WEBHOOK_URL;
    if (!webhookUrl) {
        return;
    }
    // Stop any pre-existing channel for this config before registering a new one, so a re-setup
    // never strands the previous channel as an orphan that keeps firing.
    if (config.webhookChannelId) {
        console.log(`[calendar-webhook] stopping stale channel before re-setup | config=${config._id} staleChannelId=${config.webhookChannelId}`);
        await stopChannelOnGoogle(config.webhookChannelId, config.webhookResourceId, provider, integrationId);
    }
    const channelId = randomUUID();
    const { resourceId, expiration } = await withAuthFailureHandling(integrationId, () => provider.watchEvents(config.calendarId, webhookUrl, channelId));
    await calendarSyncConfigsDAO.upsertWebhookFields(config._id, channelId, resourceId, expiration);
}

/** Stops the existing push notification channel for the given sync config. Clears webhook fields regardless of whether the stop call succeeds. */
async function teardownWatch(config: CalendarSyncConfigInterface, provider: GoogleCalendarProvider, integrationId: string): Promise<void> {
    await stopChannelOnGoogle(config.webhookChannelId, config.webhookResourceId, provider, integrationId);
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

    // setupWatch now stops any stale channel itself, so a separate teardown is no longer needed —
    // the config still carries the old channel ids when we call it, and setupWatch stops them.
    await setupWatch(config, provider, integrationId);
    console.log(`[calendar-webhook] renewed watch for config ${config._id}`);
}

export { buildProvider, renewWebhookIfExpired };

// ── Per-calendar sync serialization ──────────────────────────────────────────

// Serializes the actual `syncSingleCalendar` execution per calendar so a webhook-triggered sync and a
// manual `POST /integrations/:id/sync` cannot run concurrently and both create-on-miss for the same
// inbound event (the unique indexes make duplicates impossible, but serializing avoids the wasted
// insert→E11000→merge churn on every race). Keyed by `webhookChannelId` when present, else
// `${user}:${calendarId}` so configs without a live channel still serialize. The chain is a single
// in-process promise per key; callers `await` it, so this is a fair FIFO mutex within one process
// (Cloud Run runs --max-instances=1, so one process is the whole story).
const syncChains = new Map<string, Promise<unknown>>();

/** A stable per-calendar key for the sync mutex. */
function syncKeyFor(config: CalendarSyncConfigInterface): string {
    return config.webhookChannelId ?? `${config.user}:${config.calendarId}`;
}

/** Runs `task` after any in-flight sync for the same calendar completes, chaining so concurrent callers serialize. */
async function withSyncLock<T>(config: CalendarSyncConfigInterface, task: () => Promise<T>): Promise<T> {
    const key = syncKeyFor(config);
    const prior = syncChains.get(key) ?? Promise.resolve();
    // Swallow the predecessor's rejection here so one failed sync doesn't reject every queued caller;
    // each task's own result/rejection still propagates to its own awaiter below.
    const run = prior.then(
        () => task(),
        () => task(),
    );
    // Keep the chain pointer current; clear it once this run settles IF no later caller has extended it.
    syncChains.set(key, run);
    try {
        return await run;
    } finally {
        if (syncChains.get(key) === run) {
            syncChains.delete(key);
        }
    }
}

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
        // If runWebhookSync throws, we must clear `channelStates` (or it stays stuck and every future
        // delivery for this channel coalesces into a re-run that never fires for the lifetime of the
        // process). We also stop the loop on error: a queued re-run would just re-trigger the same
        // failure tightly; the next genuine webhook delivery will retry once the lock is free.
        try {
            await runWebhookSync(config);
        } catch (err) {
            // Hard delete rather than finishWebhookSync: if a delivery was queued during the throwing
            // sync, finishWebhookSync would leave state at 'running' with no live runner — the next
            // webhook would then coalesce into 'queued' and still not start a sync.
            channelStates.delete(channelId);
            throw err;
        }
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
    // Serialize against a concurrent manual sync for the same calendar — see withSyncLock.
    await withSyncLock(config, () => withAuthFailureHandling(integration._id, () => syncSingleCalendar(config, integration, provider, ctx)));
    console.log(`[gcal-webhook-sync] sync complete | configId=${config._id} ops=${ctx.ops.length}`);
    // Keep webhook channel alive — renew if close to expiring so the next change also triggers a webhook.
    await renewWebhookIfExpired(config, provider, integration._id).catch((err) => {
        console.error(`[calendar-webhook] renewWebhookIfExpired failed for config ${config._id}:`, err);
    });
    // Only notify when the sync actually produced operations. A 0-op webhook (GCal fired but nothing
    // changed locally — echo, content no-op, or a change on another calendar) must not buzz every
    // device: SSE wakes idle tabs into a needless pull, and web push surfaces a phone notification
    // for nothing. This was a major contributor to the staging notification storm.
    if (!ctx.ops.length) {
        console.log(`[gcal-webhook-sync] no ops — skipping SSE + push | userId=${config.user}`);
        return;
    }
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
