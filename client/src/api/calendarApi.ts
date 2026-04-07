import { API_SERVER } from '../constants/globals';
import type { StoredCalendarSyncConfig } from '../types/MyDB';

export type UnlinkAction = 'keepEvents' | 'deleteEvents' | 'deleteAll';

export interface CalendarIntegration {
    _id: string;
    provider: 'google';
    calendarId: string;
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

/** Navigates the browser to the Google Calendar OAuth flow on the API server. */
export function initiateGoogleCalendarAuth(): void {
    window.location.href = `${API_SERVER}/calendar/auth/google`;
}
