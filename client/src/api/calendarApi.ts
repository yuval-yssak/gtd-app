import { API_SERVER } from '../constants/globals';

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

export async function updateIntegration(integrationId: string, calendarId: string): Promise<void> {
    await apiFetch(`/calendar/integrations/${integrationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calendarId }),
    });
}

export async function deleteIntegration(integrationId: string, action: UnlinkAction): Promise<void> {
    await apiFetch(`/calendar/integrations/${integrationId}?action=${action}`, { method: 'DELETE' });
}

/** Navigates the browser to the Google Calendar OAuth flow on the API server. */
export function initiateGoogleCalendarAuth(): void {
    window.location.href = `${API_SERVER}/calendar/auth/google`;
}
