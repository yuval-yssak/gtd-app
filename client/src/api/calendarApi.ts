import { API_SERVER } from '../constants/globals';
import type { StoredCalendarSyncConfig } from '../types/MyDB';

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

/**
 * Navigates the browser to the Google Calendar OAuth flow on the API server.
 * `loginHint` pre-selects an account in Google's picker; the server validates the eventually
 * authorized email matches both the hint and the active session before storing tokens.
 */
export function initiateGoogleCalendarAuth(loginHint: string): void {
    const url = new URL(`${API_SERVER}/calendar/auth/google`);
    url.searchParams.set('login_hint', loginHint);
    window.location.href = url.toString();
}
