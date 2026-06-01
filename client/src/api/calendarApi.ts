import { API_SERVER } from '../constants/globals';
import { authClient } from '../lib/authClient';
import type { GCalResponseStatus, StoredCalendarSyncConfig, StoredItem } from '../types/MyDB';

export type UnlinkAction = 'keepLinkedEntities' | 'removeLinkedEntities';

export interface CalendarIntegration {
    _id: string;
    provider: 'google';
    /**
     * @deprecated Per-calendar state lives on `CalendarSyncConfig`. Step-2+ integrations omit this
     * field. Kept optional to read legacy rows.
     */
    calendarId?: string;
    lastSyncedTs?: string;
    createdTs: string;
    updatedTs: string;
}

export interface GoogleCalendar {
    id: string;
    name: string;
    /** True for the account's primary calendar — pinned to the top of the picker and pre-selected. */
    primary: boolean;
    /** Google calendarList access role: `owner`/`writer` are "your calendars"; `reader`/`freeBusyReader` are shared. */
    accessRole: string;
}

export type CalendarSyncConfig = StoredCalendarSyncConfig;

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
    // credentials: 'include' — required so the Better Auth session cookie is sent cross-origin (client ≠ API domain).
    const response = await fetch(`${API_SERVER}${path}`, { credentials: 'include', ...init });
    if (!response.ok) {
        throw new Error(`Calendar API error ${response.status}: ${await response.text()}`);
    }
    return response;
}

export async function listIntegrations(): Promise<CalendarIntegration[]> {
    const res = await apiFetch('/calendar/integrations');
    return res.json();
}

export async function listCalendars(integrationId: string): Promise<GoogleCalendar[]> {
    const res = await apiFetch(`/calendar/integrations/${integrationId}/calendars`);
    return res.json();
}

export async function linkRoutine(integrationId: string, routineId: string): Promise<{ calendarEventId: string }> {
    const res = await apiFetch(`/calendar/integrations/${integrationId}/link-routine/${routineId}`, { method: 'POST' });
    return res.json();
}

export async function syncIntegration(integrationId: string): Promise<void> {
    await apiFetch(`/calendar/integrations/${integrationId}/sync`, { method: 'POST' });
}

export async function deleteIntegration(integrationId: string, action: UnlinkAction): Promise<void> {
    await apiFetch(`/calendar/integrations/${integrationId}?action=${action}`, { method: 'DELETE' });
}

// ── Sync config management ───────────────────────────────────────────────────

export async function listSyncConfigs(integrationId: string): Promise<CalendarSyncConfig[]> {
    const res = await apiFetch(`/calendar/integrations/${integrationId}/sync-configs`);
    return res.json();
}

export async function createSyncConfig(
    integrationId: string,
    config: { calendarId: string; displayName?: string; isDefault?: boolean },
): Promise<CalendarSyncConfig> {
    const res = await apiFetch(`/calendar/integrations/${integrationId}/sync-configs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
    });
    return res.json();
}

export async function updateSyncConfig(
    integrationId: string,
    configId: string,
    updates: { enabled?: boolean; isDefault?: boolean; displayName?: string },
): Promise<CalendarSyncConfig> {
    const res = await apiFetch(`/calendar/integrations/${integrationId}/sync-configs/${configId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
    });
    return res.json();
}

export async function deleteSyncConfig(integrationId: string, configId: string): Promise<void> {
    await apiFetch(`/calendar/integrations/${integrationId}/sync-configs/${configId}`, { method: 'DELETE' });
}

// ── Aggregated multi-account view ─────────────────────────────────────────────

/** One bundle per logged-in account on this device — flattened integrations + sync configs. */
export interface AccountSyncConfigsBundle {
    userId: string;
    accountEmail: string;
    /**
     * Strips OAuth tokens (the server never returns them on this endpoint). The shape mirrors
     * `CalendarIntegration` but always includes the per-integration sync configs inline so the
     * picker can render every (account, integration, calendar) row in one read.
     */
    integrations: Array<Omit<CalendarIntegration, 'calendarId'> & { syncConfigs: CalendarSyncConfig[] }>;
}

/**
 * Returns one bundle per logged-in Better Auth session on this device. Used by the unified
 * calendar picker to enumerate every connected calendar across every logged-in account
 * without driving an active-session pivot per account.
 */
export async function getAllSyncConfigs(): Promise<AccountSyncConfigsBundle[]> {
    const res = await apiFetch('/calendar/all-sync-configs');
    return res.json();
}

// ── Online RSVP ──────────────────────────────────────────────────────────────

/**
 * The set of RSVP values the UI may push. `needsAction` is excluded — it represents the
 * "no answer yet" state and is only ever surfaced by inbound parsing.
 */
export type RsvpPushStatus = Exclude<GCalResponseStatus, 'needsAction'>;

/**
 * Discriminated result type so callers can branch without unwrapping HTTP details.
 *  - `ok: true` carries the server-returned item snapshot to seed optimistic UI reconciliation.
 *  - `ok: false, scopeMissing: true` is the 403 path — the integration lacks calendar.events
 *    write scope; the caller opens `reconsentUrl` in a popup, then retries on close.
 *  - `ok: false, error: ...` is any other failure (404, 500, network, etc.); the caller can
 *    queue an offline-replay op and surface a transient toast.
 */
export type RsvpOnlineResult =
    | { ok: true; item: StoredItem }
    | { ok: false; scopeMissing: true; reconsentUrl: string }
    | { ok: false; scopeMissing: false; error: string };

/**
 * Posts an online RSVP. Returns a discriminated result so the caller can branch on scope_missing
 * without losing the structured `reconsentUrl`. Network errors and non-2xx responses (other than
 * the 403 scope path) collapse into the generic `error` arm — the caller falls through to the
 * offline-replay queue (Phase 4) in either case.
 */
export async function rsvpOnline(itemId: string, responseStatus: RsvpPushStatus): Promise<RsvpOnlineResult> {
    const response = await fetchRsvp(itemId, responseStatus);
    if (!response) {
        return { ok: false, scopeMissing: false, error: 'network_error' };
    }
    if (response.ok) {
        return parseSuccess(response);
    }
    if (response.status === 403) {
        return parseScopeMissing(response);
    }
    return { ok: false, scopeMissing: false, error: `rsvp_failed_${response.status}` };
}

async function fetchRsvp(itemId: string, responseStatus: RsvpPushStatus): Promise<Response | null> {
    try {
        // credentials: 'include' — mirrors apiFetch above so the Better Auth session cookie rides
        // along on the cross-origin POST.
        return await fetch(`${API_SERVER}/calendar/items/${itemId}/rsvp`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ responseStatus }),
        });
    } catch {
        return null;
    }
}

async function parseSuccess(response: Response): Promise<RsvpOnlineResult> {
    const item = (await response.json()) as StoredItem;
    return { ok: true, item };
}

async function parseScopeMissing(response: Response): Promise<RsvpOnlineResult> {
    // Server shape: `{ error: 'scope_missing', reconsentUrl: string }`. Defensive parse so a server
    // bug that drops `reconsentUrl` doesn't crash the UI — we fall through to the generic error arm.
    const body = (await response.json().catch(() => null)) as { error?: string; reconsentUrl?: string } | null;
    if (body?.error === 'scope_missing' && typeof body.reconsentUrl === 'string') {
        return { ok: false, scopeMissing: true, reconsentUrl: body.reconsentUrl };
    }
    return { ok: false, scopeMissing: false, error: 'scope_missing_no_url' };
}

/**
 * Aligns the API-origin Better Auth active session to the account identified by `email` before the
 * OAuth redirect. The app tracks its active account in IndexedDB, which can drift from the active
 * session cookie on the API origin (e.g. after connecting another account). If the cookie points at
 * a DIFFERENT signed-in account, `/calendar/auth/google` stamps the wrong userId into the OAuth
 * state and the callback rejects the connect as a "mismatch" — the exact "switches me back to my
 * work account" bug. Re-asserting the active session here keeps cookie + intent in sync.
 *
 * Best-effort: a failed lookup/setActive (offline, single-session) is swallowed — the server-side
 * owner-resolution (match authorized Google email → device session) is the real guard, so the
 * redirect proceeds regardless.
 */
async function alignActiveSessionToEmail(email: string): Promise<void> {
    try {
        const { data: sessions } = await authClient.multiSession.listDeviceSessions();
        const target = sessions?.find((s) => s.user.email.toLowerCase() === email.toLowerCase());
        if (target) {
            await authClient.multiSession.setActive({ sessionToken: target.session.token });
        }
    } catch {
        // Swallow — server-side owner resolution still attaches the integration to the correct account.
    }
}

/**
 * Navigates the browser to the Google Calendar OAuth flow on the API server.
 * Aligns the API-origin active session to `loginHint` first (see `alignActiveSessionToEmail`), then
 * hands `loginHint` to Google's picker. The server validates the eventually-authorized email against
 * the hint and attaches the integration to the account that owns that Google identity.
 */
export async function initiateGoogleCalendarAuth(loginHint: string): Promise<void> {
    await alignActiveSessionToEmail(loginHint);
    const url = new URL(`${API_SERVER}/calendar/auth/google`);
    url.searchParams.set('login_hint', loginHint);
    window.location.href = url.toString();
}
