import { createHash } from 'node:crypto';
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
import type { CalendarIntegrationInterface, GCalAttendee, GCalEventType, GCalPerson, GCalResponseStatus, RoutineInterface } from '../types/entities.js';
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
 * Builds a date-only object for the Google Calendar API (all-day event). No timeZone — GCal
 * treats it as the calendar owner's local date.
 */
export function buildDate(dateStr: string): { date: string } {
    return { date: dateStr };
}

/**
 * Computes the exclusive end-date for an all-day event. GCal stores Wednesday all-day as
 * `end = Thursday`, so a single-day event has `durationDays = 1`.
 */
export function endDate(startDateStr: string, durationDays = 1): { date: string } {
    return { date: dayjs(startDateStr).add(durationDays, 'day').format('YYYY-MM-DD') };
}

/**
 * Builds the `start`/`end` pair for a recurring series request body. All-day series emit
 * `{ date }` with no timeZone (the calendar owner's local date); timed series emit
 * `{ dateTime, timeZone }` via the existing build/endDateTime helpers. Throws if a timed
 * template is missing the required `timeOfDay`+`duration` fields — the all-day branch allows
 * both to be absent. Centralizes the validation so callers don't repeat it.
 */
function buildRecurringSeriesTiming(
    template: NonNullable<RoutineInterface['calendarItemTemplate']>,
    startDate: string,
    timeZone: string,
    routineId: string,
): { start: { dateTime: string; timeZone: string } | { date: string }; end: { dateTime: string; timeZone: string } | { date: string } } {
    if (template.allDay === true) {
        return { start: buildDate(startDate), end: endDate(startDate) };
    }
    const { timeOfDay, duration } = template;
    if (timeOfDay === undefined || duration === undefined) {
        throw new Error(`Routine ${routineId} calendarItemTemplate missing timeOfDay/duration for a timed routine`);
    }
    return { start: buildDateTime(startDate, timeOfDay, timeZone), end: endDateTime(startDate, timeOfDay, duration, timeZone) };
}

/**
 * Returns the first rrule-matching date (YYYY-MM-DD) on or after the routine's createdTs.
 * Google Calendar treats DTSTART as an explicit first occurrence — if it doesn't match the
 * RRULE's BYDAY/BYMONTHDAY constraints, GCal emits a phantom occurrence on DTSTART in addition
 * to the recurrence. Snap DTSTART forward to the first real occurrence to avoid that.
 */
export function seriesStartDate(routine: RoutineInterface): string {
    // Prefer user-set startDate over createdTs. Falls back so legacy routines still work.
    const anchorDate = (routine.startDate ?? routine.createdTs).slice(0, 10);
    const dtStartStr = `${anchorDate.replace(/-/g, '')}T000000Z`;
    const rule = RRule.fromString(`DTSTART:${dtStartStr}\nRRULE:${routine.rrule}`);
    // Search strictly after (anchor - 1 day) so the first occurrence on or after the anchor
    // is returned — preserving already-matching dates (e.g. DAILY) and rolling forward to the
    // next BYDAY/BYMONTHDAY match otherwise.
    const first = rule.after(dayjs.utc(anchorDate).subtract(1, 'day').toDate(), false);
    if (!first) {
        throw new Error(`Routine ${routine._id} has an rrule with no occurrences on or after ${anchorDate}`);
    }
    return first.toISOString().slice(0, 10);
}

/**
 * Rewrites an RRULE: line to have exactly one UNTIL=<untilDate> clause, stripping any prior
 * UNTIL or COUNT (which are mutually exclusive with UNTIL in RFC 5545). Exported for testability.
 */
export function rrulePinnedUntil(rruleLine: string, untilDate: string): string {
    const prefix = 'RRULE:';
    const body = rruleLine.startsWith(prefix) ? rruleLine.slice(prefix.length) : rruleLine;
    const filtered = body
        .split(';')
        .filter((clause) => !clause.startsWith('UNTIL=') && !clause.startsWith('COUNT='))
        .join(';');
    return `${prefix}${filtered};UNTIL=${untilDate}`;
}

/** Type guard for Google API errors which carry a numeric `code` property (e.g. 410 for expired syncTokens). */
export function isGoogleApiError(err: unknown): err is Error & { code: number } {
    return err instanceof Error && 'code' in err && typeof (err as { code: unknown }).code === 'number';
}

/**
 * Type guard for OAuth `invalid_grant` (refresh token revoked / expired). Distinct from
 * `isGoogleApiError` which only inspects numeric `code`. invalid_grant typically arrives
 * without a numeric code — it's an OAuth2 protocol error, not a Calendar API error.
 *
 * googleapis surfaces it in three observed shapes: bare `Error('invalid_grant')`,
 * GaxiosError with `err.response.data.error === 'invalid_grant'`, or wrapped messages
 * containing the substring (e.g. `'Bad Request: invalid_grant'`).
 */
export function isInvalidGrantError(err: unknown): boolean {
    if (!(err instanceof Error)) {
        return false;
    }
    if (err.message === 'invalid_grant') {
        return true;
    }
    if (err.message.includes('invalid_grant')) {
        return true;
    }
    const resp = (err as { response?: { data?: { error?: unknown } } }).response;
    if (resp?.data?.error === 'invalid_grant') {
        return true;
    }
    return false;
}

/**
 * Builds a deterministic Google Calendar event id for the given (entity, integration) pair.
 * GCal accepts client-supplied ids of 5–1024 chars from the alphabet [a-v0-9] (RFC 2938 base32hex);
 * sha256 hex output is [0-9a-f] which is a strict subset, so we slice the digest directly. The
 * `gtd` prefix lets us spot app-originated events on Google's side and keeps total length at 32
 * chars (well under the 1024 max). Determinism is what closes the duplicate-event hole when
 * `events.insert` succeeds on Google but the local DB write fails — the next retry sends the
 * same id and Google replies 409 instead of accepting a second event.
 */
export function buildDeterministicGCalId(entityId: string, integrationId: string): string {
    const digest = createHash('sha256').update(`${entityId}:${integrationId}`).digest('hex');
    return `gtd${digest.slice(0, 29)}`;
}

/** True when err is a Gaxios/googleapis duplicate-id conflict (the id already exists on Google's side). */
export function isDuplicateIdError(err: unknown): boolean {
    if (!isGoogleApiError(err)) {
        return false;
    }
    return err.code === 409;
}

/** Raw shape we accept from googleapis. Loose enough to cover both `start.dateTime` and `start.date`. */
type RawGCalEvent = {
    id?: string | null;
    summary?: string | null;
    start?: { dateTime?: string | null; date?: string | null } | null;
    end?: { dateTime?: string | null; date?: string | null } | null;
    updated?: string | null;
    status?: string | null;
    recurringEventId?: string | null;
    recurrence?: string[] | null;
    description?: string | null;
    organizer?: { email?: string | null; displayName?: string | null; self?: boolean | null } | null;
    creator?: { email?: string | null; displayName?: string | null; self?: boolean | null } | null;
    attendees?: Array<{
        email?: string | null;
        displayName?: string | null;
        responseStatus?: string | null;
        self?: boolean | null;
        organizer?: boolean | null;
        optional?: boolean | null;
    }> | null;
    eventType?: string | null;
};

/** Converts a raw GCal person object into our GCalPerson shape, dropping entries without an email. */
function toPerson(raw: { email?: string | null; displayName?: string | null; self?: boolean | null } | undefined | null): GCalPerson | undefined {
    if (!raw?.email) {
        return undefined;
    }
    const person: GCalPerson = { email: raw.email };
    if (raw.displayName) {
        person.displayName = raw.displayName;
    }
    if (raw.self) {
        person.self = true;
    }
    return person;
}

/**
 * Normalizes GCal attendees into our GCalAttendee[] shape: drops entries without an email
 * (e.g. calendar resources) and sorts by email so equality checks against the previous
 * stored attendees list are stable.
 */
function toAttendees(raw: RawGCalEvent['attendees']): GCalAttendee[] | undefined {
    if (!raw || raw.length === 0) {
        return undefined;
    }
    const withEmail = raw.filter((a): a is { email: string } & typeof a => Boolean(a.email));
    const mapped = withEmail.map((a) => {
        const attendee: GCalAttendee = {
            email: a.email,
            responseStatus: (a.responseStatus as GCalResponseStatus) ?? 'needsAction',
        };
        if (a.displayName) {
            attendee.displayName = a.displayName;
        }
        if (a.self) {
            attendee.self = true;
        }
        if (a.organizer) {
            attendee.organizer = true;
        }
        if (a.optional) {
            attendee.optional = true;
        }
        return attendee;
    });
    const sorted = mapped.sort((a, b) => a.email.localeCompare(b.email));
    return sorted.length > 0 ? sorted : undefined;
}

/**
 * Parses raw Google Calendar API event items into typed GCalEvent objects. Accepts both
 * timed events (`start.dateTime`) and all-day events (`start.date`); the latter come back
 * with `allDay: true` and `timeStart`/`timeEnd` as `YYYY-MM-DD` strings (GCal's exclusive-end
 * convention preserved verbatim). Cancelled events keep their sparse shape — no attendee/
 * organizer extraction since those fields are usually absent on cancellation.
 *
 * Exported for unit testing — internal callers still go through the provider methods.
 */
export function parseGCalEvents(items: Array<Record<string, unknown>> | undefined): GCalEvent[] {
    // Type-safe cast: googleapis returns `calendar_v3.Schema$Event[]` but we treat it generically
    // here to decouple the parser from the googleapis type system.
    const events = (items ?? []) as RawGCalEvent[];
    return events.flatMap<GCalEvent>((event) => {
        const eventId = event.id;
        if (!eventId) {
            return [];
        }
        if (event.status === 'cancelled') {
            return [buildCancelledEvent(event, eventId)];
        }
        return buildConfirmedEvent(event, eventId);
    });
}

/** Cancelled events from incremental sync often lack summary/start/end — only id is required. */
function buildCancelledEvent(event: RawGCalEvent, eventId: string): GCalEvent {
    return {
        id: eventId,
        title: event.summary ?? '',
        timeStart: event.start?.dateTime ?? event.start?.date ?? '',
        timeEnd: event.end?.dateTime ?? event.end?.date ?? '',
        updated: event.updated ?? '',
        status: 'cancelled',
        ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}),
        ...(event.recurrence ? { recurrence: event.recurrence } : {}),
    };
}

/** Builds the confirmed/tentative variant, branching on dateTime vs date to support all-day events. */
function buildConfirmedEvent(event: RawGCalEvent, eventId: string): GCalEvent[] {
    if (!event.summary) {
        return [];
    }
    const timing = extractEventTiming(event);
    if (!timing) {
        return [];
    }
    const attendees = toAttendees(event.attendees);
    const status: GCalEvent['status'] = event.status === 'tentative' ? 'tentative' : 'confirmed';
    return [
        {
            id: eventId,
            title: event.summary,
            timeStart: timing.timeStart,
            timeEnd: timing.timeEnd,
            // Fall back to timeStart so last-write-wins comparison doesn't incorrectly
            // treat a missing `updated` field as "just modified now".
            updated: event.updated ?? timing.timeStart,
            status,
            ...(timing.allDay ? { allDay: true } : {}),
            ...(event.description != null ? { description: event.description } : {}),
            ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}),
            ...(event.recurrence ? { recurrence: event.recurrence } : {}),
            ...optionalField('organizer', toPerson(event.organizer)),
            ...optionalField('creator', toPerson(event.creator)),
            ...optionalField('attendees', attendees),
            ...optionalField('responseStatus', attendees?.find((a) => a.self)?.responseStatus),
            ...optionalField('eventType', event.eventType ? (event.eventType as GCalEventType) : undefined),
        },
    ];
}

/** Picks the right start/end pair, preferring dateTime when present and falling back to date for all-day. */
function extractEventTiming(event: RawGCalEvent): { timeStart: string; timeEnd: string; allDay: boolean } | null {
    if (event.start?.dateTime && event.end?.dateTime) {
        return { timeStart: event.start.dateTime, timeEnd: event.end.dateTime, allDay: false };
    }
    if (event.start?.date && event.end?.date) {
        return { timeStart: event.start.date, timeEnd: event.end.date, allDay: true };
    }
    return null;
}

/** Spreadable shorthand for `value !== undefined ? { [key]: value } : {}` with strong key typing. */
function optionalField<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
    return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
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

    async createRecurringEvent(routine: RoutineInterface, calendarId: string, timeZone: string, options?: { id?: string }): Promise<string> {
        const cal = google.calendar({ version: 'v3', auth: this.auth });
        const template = routine.calendarItemTemplate;
        if (!template) {
            throw new Error(`Routine ${routine._id} has no calendarItemTemplate`);
        }
        const startDate = seriesStartDate(routine);
        // GCal recurrence uses RRULE: prefix — the stored rrule omits it.
        const recurrence = [`RRULE:${routine.rrule}`];

        // Caller may supply a deterministic id so retries collide on 409 instead of creating a
        // second series. Without it, Google generates a fresh id per call.
        const requestBody = {
            summary: routine.title,
            ...buildRecurringSeriesTiming(template, startDate, timeZone, routine._id),
            recurrence,
            ...(routine.template.notes !== undefined ? { description: markdownToHtml(routine.template.notes) } : {}),
            ...(options?.id ? { id: options.id } : {}),
        };

        const response = await cal.events.insert({ calendarId, requestBody });

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
                ...buildRecurringSeriesTiming(template, startDate, timeZone, routine._id),
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

    /**
     * Caps the existing GCal master with UNTIL=<untilDate> via events.patch. Reads the master's
     * current recurrence array, rewrites only the RRULE clause (strips any prior UNTIL/COUNT and
     * appends the new UNTIL), and preserves EXDATE/RDATE lines untouched. Uses patch (not update)
     * so start/summary/description are left alone — this is a pure "stop producing new occurrences"
     * operation.
     */
    async capRecurringEvent(eventId: string, untilDate: string, calendarId: string, _timeZone: string): Promise<void> {
        const cal = google.calendar({ version: 'v3', auth: this.auth });
        const existing = await cal.events.get({ calendarId, eventId });
        const currentRecurrence = existing.data.recurrence ?? [];
        const nextRecurrence = currentRecurrence.map((line) => (line.startsWith('RRULE:') ? rrulePinnedUntil(line, untilDate) : line));
        await cal.events.patch({ calendarId, eventId, requestBody: { recurrence: nextRecurrence } });
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
        event: { title: string; timeStart: string; timeEnd: string; description?: string; allDay?: boolean; attendees?: GCalAttendee[] },
        timeZone: string,
        options?: { id?: string; sendUpdates?: 'all' | 'none' },
    ): Promise<string> {
        const cal = google.calendar({ version: 'v3', auth: this.auth });
        const allDay = event.allDay === true;
        // All-day requests use `{ date }` with no timeZone; timed requests use `{ dateTime, timeZone }`.
        // GCal stores all-day end as exclusive (Wed all-day → end = Thu) — we pass through whatever
        // the caller computed without converting.
        const startObj = allDay ? buildDate(event.timeStart) : { dateTime: event.timeStart, timeZone };
        const endObj = allDay ? buildDate(event.timeEnd) : { dateTime: event.timeEnd, timeZone };
        // Caller may supply a deterministic id so retries collide on 409 instead of creating a
        // second event. Without it, Google generates a fresh id per call.
        const requestBody = {
            summary: event.title,
            start: startObj,
            end: endObj,
            ...(event.description !== undefined ? { description: event.description } : {}),
            ...(event.attendees !== undefined ? { attendees: event.attendees } : {}),
            ...(options?.id ? { id: options.id } : {}),
        };
        // sendUpdates defaults to 'none' to preserve the historical silent-create behavior. Callers
        // that want attendees to receive an invite must opt in explicitly.
        const response = await cal.events.insert({ calendarId, requestBody, sendUpdates: options?.sendUpdates ?? 'none' });
        const eventId = response.data.id;
        if (!eventId) {
            throw new Error('Google Calendar did not return an event ID');
        }
        return eventId;
    }

    async updateEvent(
        calendarId: string,
        eventId: string,
        updates: {
            title?: string;
            timeStart?: string;
            timeEnd?: string;
            description?: string;
            colorId?: string | null;
            allDay?: boolean;
            attendees?: GCalAttendee[];
        },
        timeZone: string,
        options?: { sendUpdates?: 'all' | 'none' },
    ): Promise<void> {
        const cal = google.calendar({ version: 'v3', auth: this.auth });
        const allDay = updates.allDay === true;
        // Use patch (not update) so only the provided fields are modified — update would clear omitted fields.
        // `colorId: null` is forwarded as-is so Google clears the override and the event reverts to the
        // calendar's default color; `undefined` skips the field entirely.
        await cal.events.patch({
            calendarId,
            eventId,
            requestBody: {
                ...(updates.title !== undefined ? { summary: updates.title } : {}),
                ...(updates.timeStart !== undefined ? { start: allDay ? buildDate(updates.timeStart) : { dateTime: updates.timeStart, timeZone } } : {}),
                ...(updates.timeEnd !== undefined ? { end: allDay ? buildDate(updates.timeEnd) : { dateTime: updates.timeEnd, timeZone } } : {}),
                ...(updates.description !== undefined ? { description: updates.description } : {}),
                ...(updates.colorId !== undefined ? { colorId: updates.colorId } : {}),
                ...(updates.attendees !== undefined ? { attendees: updates.attendees } : {}),
            },
            // Default 'none' preserves current silent-edit behavior for code paths that don't yet
            // forward the user's SendUpdatesDialog choice.
            sendUpdates: options?.sendUpdates ?? 'none',
        });
    }

    async deleteEvent(calendarId: string, eventId: string): Promise<void> {
        const cal = google.calendar({ version: 'v3', auth: this.auth });
        await cal.events.delete({ calendarId, eventId });
    }

    async updateRecurringInstance(
        masterEventId: string,
        originalDate: string,
        updates: {
            title?: string;
            timeStart?: string;
            timeEnd?: string;
            description?: string;
            colorId?: string | null;
            allDay?: boolean;
            attendees?: GCalAttendee[];
        },
        calendarId: string,
        timeZone: string,
        options?: { sendUpdates?: 'all' | 'none' },
    ): Promise<void> {
        const instanceId = await this.findInstanceId(masterEventId, originalDate, calendarId, 'updateRecurringInstance');
        if (!instanceId) {
            return;
        }
        const cal = google.calendar({ version: 'v3', auth: this.auth });
        const allDay = updates.allDay === true;
        await cal.events.patch({
            calendarId,
            eventId: instanceId,
            requestBody: {
                ...(updates.title !== undefined ? { summary: updates.title } : {}),
                ...(updates.timeStart !== undefined ? { start: allDay ? buildDate(updates.timeStart) : { dateTime: updates.timeStart, timeZone } } : {}),
                ...(updates.timeEnd !== undefined ? { end: allDay ? buildDate(updates.timeEnd) : { dateTime: updates.timeEnd, timeZone } } : {}),
                ...(updates.description !== undefined ? { description: updates.description } : {}),
                ...(updates.colorId !== undefined ? { colorId: updates.colorId } : {}),
                ...(updates.attendees !== undefined ? { attendees: updates.attendees } : {}),
            },
            // cal.events.patch accepts sendUpdates the same as update; default 'none' preserves the
            // historical silent-override behavior for code paths that don't yet forward a choice.
            sendUpdates: options?.sendUpdates ?? 'none',
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
