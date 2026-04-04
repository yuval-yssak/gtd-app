import dayjs from 'dayjs';
import { google } from 'googleapis';
import type { CalendarIntegrationInterface, RoutineInterface } from '../types/entities.js';
import type { CalendarProvider, GCalEvent, GCalException } from './CalendarProvider.js';

/** Builds a dateTime object for the Google Calendar API from a date string and HH:MM time. */
function buildDateTime(dateStr: string, timeOfDay: string, timeZone: string): { dateTime: string; timeZone: string } {
    return { dateTime: `${dateStr}T${timeOfDay}:00`, timeZone };
}

/** Computes the end dateTime by adding duration to the start. Uses dayjs to handle midnight overflow correctly. */
function endDateTime(dateStr: string, timeOfDay: string, durationMinutes: number, timeZone: string): { dateTime: string; timeZone: string } {
    const end = dayjs(`${dateStr}T${timeOfDay}`).add(durationMinutes, 'minute');
    return { dateTime: end.format('YYYY-MM-DDTHH:mm:ss'), timeZone };
}

/** Returns a stable anchor date (YYYY-MM-DD) to use as DTSTART for the event series. */
function seriesStartDate(routine: RoutineInterface): string {
    // Use createdTs date so the rrule series origin matches when the routine was defined.
    return routine.createdTs.slice(0, 10);
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
            // Track the latest refresh token locally so repeated refreshes don't fall back to the
            // stale value captured at construction time.
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

    async createRecurringEvent(routine: RoutineInterface, calendarId: string): Promise<string> {
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
                start: buildDateTime(startDate, template.timeOfDay, 'UTC'),
                end: endDateTime(startDate, template.timeOfDay, template.duration, 'UTC'),
                recurrence,
            },
        });

        const eventId = response.data.id;
        if (!eventId) {
            throw new Error('Google Calendar did not return an event ID');
        }
        return eventId;
    }

    async updateRecurringEvent(eventId: string, routine: RoutineInterface, calendarId: string): Promise<void> {
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
                start: buildDateTime(startDate, template.timeOfDay, 'UTC'),
                end: endDateTime(startDate, template.timeOfDay, template.duration, 'UTC'),
                recurrence: [`RRULE:${routine.rrule}`],
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

        // All-day events use event.start.date (no dateTime) — skipped intentionally since
        // calendar items in this app require a specific datetime, not just a date.
        return (response.data.items ?? []).flatMap((event) => {
            if (!event.id || !event.summary || !event.start?.dateTime || !event.end?.dateTime) {
                return [];
            }
            const rawStatus = event.status;
            const status: GCalEvent['status'] = rawStatus === 'cancelled' ? 'cancelled' : rawStatus === 'tentative' ? 'tentative' : 'confirmed';
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
                    ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}),
                },
            ];
        });
    }

    async getExceptions(eventId: string, calendarId: string, since: string): Promise<GCalException[]> {
        const cal = google.calendar({ version: 'v3', auth: this.auth });

        // singleEvents: true expands the recurrence so we get individual instances.
        // showDeleted: true includes cancelled (deleted) instances.
        // orderBy: 'startTime' requires singleEvents: true.
        // timeMax caps the window to 1 year ahead — without it Google returns all future
        // instances which can be thousands for long-running routines.
        const timeMax = dayjs(since).add(1, 'year').toISOString();
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

            // Detect moved instances: compare start against originalStartTime.
            const startDateTime = event.start?.dateTime;
            const originalDateTime = event.originalStartTime?.dateTime;
            if (startDateTime && originalDateTime && startDateTime !== originalDateTime) {
                return [
                    {
                        originalDate,
                        type: 'modified',
                        newTimeStart: startDateTime,
                        ...(event.end?.dateTime ? { newTimeEnd: event.end.dateTime } : {}),
                        ...(event.id ? { googleEventId: event.id } : {}),
                    },
                ];
            }

            return [];
        });
    }
}
