import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { google } from 'googleapis';
import rrule from 'rrule';

// `rrule@2.8.1` ships a UMD/CJS bundle as its `main` (no conditional exports), so under Node's
// ESM loader a named import fails at runtime even though types resolve via `dist/esm/index.d.ts`.
// Default-import then destructure works across tsx/Vitest/Node via esModuleInterop.
const { RRule } = rrule;

dayjs.extend(utc);

import { markdownToHtml } from '../lib/markdownHtml.js';
import type { CalendarIntegrationInterface, RoutineInterface } from '../types/entities.js';
import type { CalendarProvider, EventSyncResult, GCalEvent, GCalException, MasterContent } from './CalendarProvider.js';
import { SyncTokenInvalidError } from './CalendarProvider.js';

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function assertValidTimeOfDay(timeOfDay: string): void {
    if (!TIME_OF_DAY_PATTERN.test(timeOfDay)) {
        throw new Error(`Invalid timeOfDay "${timeOfDay}" — expected HH:MM format`);
    }
}

/** Builds a dateTime object for the Google Calendar API from a date string and HH:MM time. */
export function buildDateTime(dateStr: string, timeOfDay: string, timeZone: string): { dateTime: string; timeZone: string } {
    assertValidTimeOfDay(timeOfDay);
    return { dateTime: `${dateStr}T${timeOfDay}:00`, timeZone };
}

/** Computes the end dateTime by adding duration to the start. Uses dayjs to handle midnight overflow correctly. */
export function endDateTime(dateStr: string, timeOfDay: string, durationMinutes: number, timeZone: string): { dateTime: string; timeZone: string } {
    assertValidTimeOfDay(timeOfDay);
    const end = dayjs(`${dateStr}T${timeOfDay}`).add(durationMinutes, 'minute');
    return { dateTime: end.format('YYYY-MM-DDTHH:mm:ss'), timeZone };
}

/**
 * Returns the first rrule-matching date (YYYY-MM-DD) on or after the routine's createdTs.
 * Google Calendar treats DTSTART as an explicit first occurrence — if it doesn't match the
 * RRULE's BYDAY/BYMONTHDAY constraints, GCal emits a phantom occurrence on DTSTART in addition
 * to the recurrence. Snap DTSTART forward to the first real occurrence to avoid that.
 */
export function seriesStartDate(routine: RoutineInterface): string {
    const createdDate = routine.createdTs.slice(0, 10);
    const dtStartStr = `${createdDate.replace(/-/g, '')}T000000Z`;
    const rule = RRule.fromString(`DTSTART:${dtStartStr}\nRRULE:${routine.rrule}`);
    // Search strictly after (createdTs - 1 day) so the first occurrence on or after createdTs
    // is returned — preserving already-matching dates (e.g. DAILY) and rolling forward to the
    // next BYDAY/BYMONTHDAY match otherwise.
    const first = rule.after(dayjs.utc(createdDate).subtract(1, 'day').toDate(), false);
    if (!first) {
        throw new Error(`Routine ${routine._id} has an rrule with no occurrences on or after ${createdDate}`);
    }
    return first.toISOString().slice(0, 10);
}

/** Type guard for Google API errors which carry a numeric `code` property (e.g. 410 for expired syncTokens). */
function isGoogleApiError(err: unknown): err is Error & { code: number } {
    return err instanceof Error && 'code' in err && typeof (err as { code: unknown }).code === 'number';
}

/** Parses raw Google Calendar API event items into typed GCalEvent objects. Skips all-day events (no dateTime). */
function parseGCalEvents(items: Array<Record<string, unknown>> | undefined): GCalEvent[] {
    // Type-safe cast: googleapis returns `calendar_v3.Schema$Event[]` but we treat it generically
    // here to decouple the parser from the googleapis type system.
    const events = (items ?? []) as Array<{
        id?: string | null;
        summary?: string | null;
        start?: { dateTime?: string | null; date?: string | null } | null;
        end?: { dateTime?: string | null } | null;
        updated?: string | null;
        status?: string | null;
        recurringEventId?: string | null;
        recurrence?: string[] | null;
        description?: string | null;
    }>;
    return events.flatMap<GCalEvent>((event) => {
        if (!event.id) {
            return [];
        }
        // Cancelled events from incremental sync often lack summary/start/end —
        // only id and status are needed for the trash-on-cancel path in upsertCalendarItem.
        if (event.status === 'cancelled') {
            return [
                {
                    id: event.id,
                    title: event.summary ?? '',
                    timeStart: event.start?.dateTime ?? '',
                    timeEnd: event.end?.dateTime ?? '',
                    updated: event.updated ?? '',
                    status: 'cancelled',
                    ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}),
                    ...(event.recurrence ? { recurrence: event.recurrence } : {}),
                },
            ];
        }
        if (!event.summary || !event.start?.dateTime || !event.end?.dateTime) {
            return [];
        }
        const rawStatus = event.status;
        const status: GCalEvent['status'] = rawStatus === 'tentative' ? 'tentative' : 'confirmed';
        return [
            {
                id: event.id,
                title: event.summary,
                timeStart: event.start.dateTime,
                timeEnd: event.end.dateTime,
                // Fall back to timeStart so last-write-wins comparison doesn't incorrectly
                // treat a missing `updated` field as "just modified now".
                updated: event.updated ?? event.start.dateTime,
                status,
                ...(event.description != null ? { description: event.description } : {}),
                ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}),
                ...(event.recurrence ? { recurrence: event.recurrence } : {}),
            },
        ];
    });
}

export class GoogleCalendarProvider implements CalendarProvider {
    private readonly auth: InstanceType<typeof google.auth.OAuth2>;

    constructor(integration: CalendarIntegrationInterface, onTokenRefresh?: (accessToken: string, refreshToken: string, expiry: string) => Promise<void>) {
        const oauth2 = new google.auth.OAuth2(
            process.env.GOOGLE_OAUTH_APP_CLIENT_ID,
            process.env.GOOGLE_OAUTH_APP_CLIENT_SECRET,
            `${process.env.BETTER_AUTH_URL ?? 'http://localhost:4000'}/calendar/auth/google/callback`,
        );
        oauth2.setCredentials({
            access_token: integration.accessToken,
            refresh_token: integration.refreshToken,
            // googleapis expects expiry_date as unix ms — dayjs().valueOf() returns that.
            expiry_date: dayjs(integration.tokenExpiry).valueOf(),
        });
        if (onTokenRefresh) {
            // googleapis emits 'tokens' whenever it silently refreshes an expired access token.
            // Persist the new credentials so the next request doesn't start with a stale token.
            // Must be let — updated on each token refresh event so subsequent persists use the
            // latest value instead of the stale one captured at construction time.
            let latestRefreshToken = integration.refreshToken;
            let latestTokenExpiry = integration.tokenExpiry;
            oauth2.on('tokens', (tokens) => {
                if (!tokens.access_token) {
                    // Partial token events (no access_token) can occur on malformed responses —
                    // nothing useful to persist; persisting the old expired token would cause a loop.
                    console.warn('[GoogleCalendarProvider] tokens event fired without access_token; skipping persist');
                    return;
                }
                if (tokens.refresh_token) {
                    latestRefreshToken = tokens.refresh_token;
                }
                const expiry = tokens.expiry_date ? dayjs(tokens.expiry_date).toISOString() : latestTokenExpiry;
                latestTokenExpiry = expiry;
                onTokenRefresh(tokens.access_token, latestRefreshToken, expiry).catch(console.error);
            });
        }
        this.auth = oauth2;
    }

    async getCalendarTimeZone(calendarId: string): Promise<string> {
        const cal = google.calendar({ version: 'v3', auth: this.auth });
        const response = await cal.calendars.get({ calendarId });
        if (!response.data.timeZone) {
            console.warn(`[GoogleCalendarProvider] calendars.get returned no timeZone for ${calendarId} — falling back to UTC`);
        }
        return response.data.timeZone ?? 'UTC';
    }

    async createRecurringEvent(routine: RoutineInterface, calendarId: string, timeZone: string): Promise<string> {
        const cal = google.calendar({ version: 'v3', auth: this.auth });
        const template = routine.calendarItemTemplate;
        if (!template) {
            throw new Error(`Routine ${routine._id} has no calendarItemTemplate`);
        }

        const startDate = seriesStartDate(routine);
        // GCal recurrence uses RRULE: prefix — the stored rrule omits it.
        const recurrence = [`RRULE:${routine.rrule}`];

        const response = await cal.events.insert({
            calendarId,
            requestBody: {
                summary: routine.title,
                start: buildDateTime(startDate, template.timeOfDay, timeZone),
                end: endDateTime(startDate, template.timeOfDay, template.duration, timeZone),
                recurrence,
                ...(routine.template.notes !== undefined ? { description: markdownToHtml(routine.template.notes) } : {}),
            },
        });

        const eventId = response.data.id;
        if (!eventId) {
            throw new Error('Google Calendar did not return an event ID');
        }
        return eventId;
    }

    async updateRecurringEvent(eventId: string, routine: RoutineInterface, calendarId: string, timeZone: string): Promise<void> {
        const cal = google.calendar({ version: 'v3', auth: this.auth });
        const template = routine.calendarItemTemplate;
        if (!template) {
            throw new Error(`Routine ${routine._id} has no calendarItemTemplate`);
        }

        const startDate = seriesStartDate(routine);
        await cal.events.update({
            calendarId,
            eventId,
            requestBody: {
                summary: routine.title,
                start: buildDateTime(startDate, template.timeOfDay, timeZone),
                end: endDateTime(startDate, template.timeOfDay, template.duration, timeZone),
                recurrence: [`RRULE:${routine.rrule}`],
                // events.update is a full replace — always send description to avoid leaving stale values.
                description: routine.template.notes ? markdownToHtml(routine.template.notes) : '',
            },
        });
    }

    async deleteRecurringEvent(eventId: string, calendarId: string): Promise<void> {
        const cal = google.calendar({ version: 'v3', auth: this.auth });
        await cal.events.delete({ calendarId, eventId });
    }

    async listCalendars(): Promise<Array<{ id: string; name: string }>> {
        const cal = google.calendar({ version: 'v3', auth: this.auth });
        const response = await cal.calendarList.list();
        return (response.data.items ?? [])
            .filter((item): item is typeof item & { id: string; summary: string } => Boolean(item.id && item.summary))
            .map((item) => ({ id: item.id, name: item.summary }));
    }

    async listEvents(calendarId: string, since: string, until: string): Promise<GCalEvent[]> {
        const cal = google.calendar({ version: 'v3', auth: this.auth });

        // singleEvents: true expands recurring series into individual instances so each
        // occurrence gets its own id, timeStart, and timeEnd — needed for per-event upsert.
        // showDeleted: true includes cancelled events so we can trash the corresponding items.
        const response = await cal.events.list({
            calendarId,
            timeMin: since,
            timeMax: until,
            singleEvents: true,
            showDeleted: true,
            orderBy: 'startTime',
        });

        return parseGCalEvents(response.data.items as Array<Record<string, unknown>> | undefined);
    }

    async listEventsIncremental(calendarId: string, syncToken: string): Promise<EventSyncResult> {
        try {
            // syncToken returns only events changed since the token was issued.
            // showDeleted must be true to receive cancellation notifications.
            // singleEvents must NOT be set when using syncToken — Google rejects the combination.
            return await this.paginatedEventsFetch({ calendarId, syncToken, showDeleted: true }, syncToken);
        } catch (err: unknown) {
            // Google returns 410 Gone when the syncToken has expired or been invalidated.
            if (isGoogleApiError(err) && err.code === 410) {
                throw new SyncTokenInvalidError();
            }
            throw err;
        }
    }

    async listEventsFull(calendarId: string, timeMin: string): Promise<EventSyncResult> {
        // Initial full sync: fetch all future events and obtain a syncToken for incremental use.
        // singleEvents must NOT be set so that Google returns a nextSyncToken.
        return this.paginatedEventsFetch({ calendarId, timeMin, showDeleted: true }, '');
    }

    /**
     * Fetches all pages of events from Google Calendar.
     * Google returns max ~250 events per page; nextSyncToken is only present on the final page.
     */
    private async paginatedEventsFetch(params: Record<string, unknown>, fallbackSyncToken: string): Promise<EventSyncResult> {
        const cal = google.calendar({ version: 'v3', auth: this.auth });
        const allEvents: GCalEvent[] = [];
        let pageToken: string | undefined;

        do {
            const response = await cal.events.list({ ...params, ...(pageToken ? { pageToken } : {}) });
            allEvents.push(...parseGCalEvents(response.data.items as Array<Record<string, unknown>> | undefined));
            pageToken = response.data.nextPageToken ?? undefined;
            // nextSyncToken is only present on the final page (when nextPageToken is absent).
            if (!pageToken) {
                return { events: allEvents, nextSyncToken: response.data.nextSyncToken ?? fallbackSyncToken };
            }
        } while (pageToken);

        // Unreachable — the do-while exits via the return above when pageToken is absent.
        return { events: allEvents, nextSyncToken: fallbackSyncToken };
    }

    async watchEvents(calendarId: string, webhookUrl: string, channelId: string): Promise<{ resourceId: string; expiration: string }> {
        const cal = google.calendar({ version: 'v3', auth: this.auth });
        const response = await cal.events.watch({
            calendarId,
            requestBody: {
                id: channelId,
                type: 'web_hook',
                address: webhookUrl,
            },
        });
        const resourceId = response.data.resourceId;
        if (!resourceId) {
            throw new Error('Google Calendar did not return a resourceId for the watch channel');
        }
        // Google returns expiration as unix ms string — convert to ISO for consistent storage.
        const expiration = response.data.expiration ? dayjs(Number(response.data.expiration)).toISOString() : dayjs().add(7, 'day').toISOString();
        return { resourceId, expiration };
    }

    async stopWatch(channelId: string, resourceId: string): Promise<void> {
        const cal = google.calendar({ version: 'v3', auth: this.auth });
        await cal.channels.stop({ requestBody: { id: channelId, resourceId } });
    }

    async createEvent(
        calendarId: string,
        event: { title: string; timeStart: string; timeEnd: string; description?: string },
        timeZone: string,
    ): Promise<string> {
        const cal = google.calendar({ version: 'v3', auth: this.auth });
        const response = await cal.events.insert({
            calendarId,
            requestBody: {
                summary: event.title,
                start: { dateTime: event.timeStart, timeZone },
                end: { dateTime: event.timeEnd, timeZone },
                ...(event.description !== undefined ? { description: event.description } : {}),
            },
        });
        const eventId = response.data.id;
        if (!eventId) {
            throw new Error('Google Calendar did not return an event ID');
        }
        return eventId;
    }

    async updateEvent(
        calendarId: string,
        eventId: string,
        updates: { title?: string; timeStart?: string; timeEnd?: string; description?: string },
        timeZone: string,
    ): Promise<void> {
        const cal = google.calendar({ version: 'v3', auth: this.auth });
        // Use patch (not update) so only the provided fields are modified — update would clear omitted fields.
        await cal.events.patch({
            calendarId,
            eventId,
            requestBody: {
                ...(updates.title !== undefined ? { summary: updates.title } : {}),
                ...(updates.timeStart !== undefined ? { start: { dateTime: updates.timeStart, timeZone } } : {}),
                ...(updates.timeEnd !== undefined ? { end: { dateTime: updates.timeEnd, timeZone } } : {}),
                ...(updates.description !== undefined ? { description: updates.description } : {}),
            },
        });
    }

    async deleteEvent(calendarId: string, eventId: string): Promise<void> {
        const cal = google.calendar({ version: 'v3', auth: this.auth });
        await cal.events.delete({ calendarId, eventId });
    }

    async updateRecurringInstance(
        masterEventId: string,
        originalDate: string,
        updates: { title?: string; timeStart?: string; timeEnd?: string; description?: string },
        calendarId: string,
        timeZone: string,
    ): Promise<void> {
        const instanceId = await this.findInstanceId(masterEventId, originalDate, calendarId, 'updateRecurringInstance');
        if (!instanceId) {
            return;
        }
        const cal = google.calendar({ version: 'v3', auth: this.auth });
        await cal.events.patch({
            calendarId,
            eventId: instanceId,
            requestBody: {
                ...(updates.title !== undefined ? { summary: updates.title } : {}),
                ...(updates.timeStart !== undefined ? { start: { dateTime: updates.timeStart, timeZone } } : {}),
                ...(updates.timeEnd !== undefined ? { end: { dateTime: updates.timeEnd, timeZone } } : {}),
                ...(updates.description !== undefined ? { description: updates.description } : {}),
            },
        });
    }

    async cancelRecurringInstance(masterEventId: string, originalDate: string, calendarId: string): Promise<void> {
        const instanceId = await this.findInstanceId(masterEventId, originalDate, calendarId, 'cancelRecurringInstance');
        if (!instanceId) {
            return;
        }
        const cal = google.calendar({ version: 'v3', auth: this.auth });
        await cal.events.patch({ calendarId, eventId: instanceId, requestBody: { status: 'cancelled' } });
    }

    /**
     * Resolves the instance-specific event id for a given occurrence date of a recurring master.
     * Windows the `events.instances` call by ±1 day because `dayjs(dateString).startOf('day')` uses
     * the server's local timezone, but the instance's UTC start can fall on the prior UTC day for any
     * calendar in a positive-offset timezone. ±1 day covers every real-world tz and keeps pagination
     * tiny; the `.find()` narrows to the exact `originalDate` via string comparison.
     */
    private async findInstanceId(masterEventId: string, originalDate: string, calendarId: string, callerLabel: string): Promise<string | null> {
        const cal = google.calendar({ version: 'v3', auth: this.auth });
        const windowStart = dayjs(originalDate).subtract(1, 'day').toISOString();
        const windowEnd = dayjs(originalDate).add(1, 'day').toISOString();
        const instanceList = await cal.events.instances({
            calendarId,
            eventId: masterEventId,
            timeMin: windowStart,
            timeMax: windowEnd,
            showDeleted: false,
            maxResults: 10,
        });
        const instance = (instanceList.data.items ?? []).find((ev) => {
            const origIso = ev.originalStartTime?.dateTime ?? ev.originalStartTime?.date ?? '';
            return origIso.slice(0, 10) === originalDate;
        });
        if (!instance?.id) {
            // Surface as a warning so the fire-and-forget pushback caller doesn't throw.
            console.warn(`[GoogleCalendarProvider] ${callerLabel}: no instance for master ${masterEventId} on ${originalDate} — skipping`);
            return null;
        }
        return instance.id;
    }

    async getExceptions(eventId: string, calendarId: string, since: string, masterContent?: MasterContent): Promise<GCalException[]> {
        const cal = google.calendar({ version: 'v3', auth: this.auth });

        // singleEvents: true expands the recurrence so we get individual instances.
        // showDeleted: true includes cancelled (deleted) instances.
        // orderBy: 'startTime' requires singleEvents: true.
        // timeMax caps the window to 1 year ahead of NOW — anchoring to `since` would give a useless
        // window on the first sync (since defaults to 1970-01-01 when lastSyncedTs is unset).
        const timeMax = dayjs().add(1, 'year').toISOString();
        const response = await cal.events.list({
            calendarId,
            timeMin: since,
            timeMax,
            singleEvents: true,
            showDeleted: true,
            orderBy: 'startTime',
        });

        return (response.data.items ?? []).flatMap((event): GCalException[] => {
            // Only care about instances that belong to this recurring series.
            if (event.recurringEventId !== eventId) {
                return [];
            }

            const originalDate = event.originalStartTime?.dateTime?.slice(0, 10) ?? event.originalStartTime?.date;
            if (!originalDate) {
                return [];
            }

            if (event.status === 'cancelled') {
                // Spread optional fields conditionally — exactOptionalPropertyTypes forbids assigning `string | undefined` to `string`.
                return [{ originalDate, type: 'deleted', ...(event.id ? { googleEventId: event.id } : {}) }];
            }

            return buildModifiedException(event, originalDate, masterContent);
        });
    }
}

/** Detects time-move and/or content changes on a non-cancelled instance compared to the master. */
function buildModifiedException(
    event: {
        start?: { dateTime?: string | null } | null;
        end?: { dateTime?: string | null } | null;
        originalStartTime?: { dateTime?: string | null } | null;
        summary?: string | null;
        description?: string | null;
        id?: string | null;
    },
    originalDate: string,
    masterContent?: MasterContent,
): GCalException[] {
    const startDateTime = event.start?.dateTime;
    const originalDateTime = event.originalStartTime?.dateTime;
    const timeMoved = Boolean(startDateTime && originalDateTime && startDateTime !== originalDateTime);

    const instanceTitle = event.summary ?? '';
    const instanceDesc = event.description ?? '';
    const titleChanged = masterContent ? instanceTitle !== masterContent.title : false;
    const descChanged = masterContent ? instanceDesc !== masterContent.description : false;

    if (!timeMoved && !titleChanged && !descChanged) {
        return [];
    }

    return [
        {
            originalDate,
            type: 'modified',
            ...(timeMoved && startDateTime ? { newTimeStart: startDateTime } : {}),
            ...(timeMoved && event.end?.dateTime ? { newTimeEnd: event.end.dateTime } : {}),
            ...(titleChanged ? { title: instanceTitle } : {}),
            ...(descChanged ? { notes: instanceDesc } : {}),
            ...(event.id ? { googleEventId: event.id } : {}),
        },
    ];
}
