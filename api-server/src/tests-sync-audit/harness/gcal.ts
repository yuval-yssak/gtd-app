import { google } from 'googleapis';
import { loadSecrets } from './env.js';

/**
 * Thin, test-focused wrapper over the Google Calendar API.
 * Uses the stored refresh token; googleapis mints access tokens silently.
 */

function buildClient() {
    const clientId = process.env.GOOGLE_OAUTH_APP_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_APP_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('Missing GOOGLE_OAUTH_APP_CLIENT_ID / GOOGLE_OAUTH_APP_CLIENT_SECRET in env');
    }
    const { refreshToken } = loadSecrets();
    // redirect URI doesn't matter for refresh-token grants — googleapis only uses it at auth-code exchange.
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:4466/callback');
    oauth2.setCredentials({ refresh_token: refreshToken });
    return google.calendar({ version: 'v3', auth: oauth2 });
}

let cached: ReturnType<typeof buildClient> | null = null;
function client() {
    if (!cached) cached = buildClient();
    return cached;
}

export function gcalCalendarId(): string {
    return loadSecrets().calendarId;
}

export async function getTimeZone(): Promise<string> {
    const res = await client().calendars.get({ calendarId: gcalCalendarId() });
    return res.data.timeZone ?? 'UTC';
}

export interface CreateRecurringArgs {
    summary: string;
    description?: string;
    rrule: string; // e.g. 'FREQ=WEEKLY;BYDAY=MO'
    startDate: string; // YYYY-MM-DD
    timeOfDay: string; // HH:MM
    durationMinutes: number;
    timeZone: string;
}

export async function createRecurringEvent(args: CreateRecurringArgs): Promise<string> {
    const start = { dateTime: `${args.startDate}T${args.timeOfDay}:00`, timeZone: args.timeZone };
    const endDate = new Date(`${args.startDate}T${args.timeOfDay}:00Z`);
    endDate.setUTCMinutes(endDate.getUTCMinutes() + args.durationMinutes);
    const pad = (n: number) => n.toString().padStart(2, '0');
    const endTimeStr = `${pad(endDate.getUTCHours())}:${pad(endDate.getUTCMinutes())}`;
    const end = { dateTime: `${args.startDate}T${endTimeStr}:00`, timeZone: args.timeZone };

    const res = await client().events.insert({
        calendarId: gcalCalendarId(),
        requestBody: {
            summary: args.summary,
            ...(args.description !== undefined ? { description: args.description } : {}),
            start,
            end,
            recurrence: [`RRULE:${args.rrule}`],
        },
    });
    if (!res.data.id) throw new Error('createRecurringEvent: no id returned');
    return res.data.id;
}

export async function getEvent(eventId: string) {
    const res = await client().events.get({ calendarId: gcalCalendarId(), eventId });
    return res.data;
}

export interface EventListEntry {
    id: string;
    summary: string;
    recurringEventId?: string;
    status?: string;
}

/** Lists every event (including instances) whose summary starts with the given prefix. */
export async function listEventsByPrefix(prefix: string): Promise<EventListEntry[]> {
    const out: EventListEntry[] = [];
    let pageToken: string | undefined;
    do {
        const res = await client().events.list({
            calendarId: gcalCalendarId(),
            // Expand recurring series so we can delete orphaned instances; we'll
            // still filter by summary prefix which both master and instances share.
            singleEvents: false,
            showDeleted: true,
            maxResults: 250,
            ...(pageToken ? { pageToken } : {}),
        });
        for (const ev of res.data.items ?? []) {
            if (!ev.id) continue;
            const summary = ev.summary ?? '';
            if (!summary.startsWith(prefix)) continue;
            out.push({
                id: ev.id,
                summary,
                ...(ev.recurringEventId ? { recurringEventId: ev.recurringEventId } : {}),
                ...(ev.status ? { status: ev.status } : {}),
            });
        }
        pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
}

export async function deleteEvent(eventId: string): Promise<void> {
    try {
        await client().events.delete({ calendarId: gcalCalendarId(), eventId });
    } catch (err: unknown) {
        const code = (err as { code?: number }).code;
        // 404/410 = already gone; safe to ignore during cleanup.
        if (code === 404 || code === 410) return;
        throw err;
    }
}

/** Finds an instance of a recurring series by its original date (YYYY-MM-DD). */
export async function findInstanceByDate(
    recurringEventId: string,
    date: string,
): Promise<{ id: string; start: string; end: string; summary: string; description?: string } | null> {
    // instances endpoint lists all occurrences (including exceptions) of the master event.
    const res = await client().events.instances({
        calendarId: gcalCalendarId(),
        eventId: recurringEventId,
        timeMin: `${date}T00:00:00Z`,
        timeMax: `${date}T23:59:59Z`,
        showDeleted: true,
        maxResults: 50,
    });
    for (const inst of res.data.items ?? []) {
        if (!inst.id || !inst.start?.dateTime || !inst.end?.dateTime) continue;
        const origDate = inst.originalStartTime?.dateTime?.slice(0, 10) ?? inst.start.dateTime.slice(0, 10);
        if (origDate !== date) continue;
        return {
            id: inst.id,
            start: inst.start.dateTime,
            end: inst.end.dateTime,
            summary: inst.summary ?? '',
            ...(inst.description != null ? { description: inst.description } : {}),
        };
    }
    return null;
}

/** Moves a single instance (creates an override on the series). */
export async function modifyInstance(
    instanceId: string,
    patch: { summary?: string; description?: string; newTimeStart?: string; newTimeEnd?: string; timeZone: string },
): Promise<void> {
    await client().events.patch({
        calendarId: gcalCalendarId(),
        eventId: instanceId,
        requestBody: {
            ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
            ...(patch.newTimeStart ? { start: { dateTime: patch.newTimeStart, timeZone: patch.timeZone } } : {}),
            ...(patch.newTimeEnd ? { end: { dateTime: patch.newTimeEnd, timeZone: patch.timeZone } } : {}),
        },
    });
}

/** Deletes a single instance of a recurring series (creates a cancellation override). */
export async function cancelInstance(instanceId: string): Promise<void> {
    await client().events.delete({ calendarId: gcalCalendarId(), eventId: instanceId });
}

/** Updates the master event (patch semantics — only provided fields change). */
export async function patchMasterEvent(eventId: string, patch: { summary?: string; description?: string }): Promise<void> {
    await client().events.patch({
        calendarId: gcalCalendarId(),
        eventId,
        requestBody: {
            ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
        },
    });
}

export async function deleteMasterEvent(eventId: string): Promise<void> {
    await deleteEvent(eventId);
}
