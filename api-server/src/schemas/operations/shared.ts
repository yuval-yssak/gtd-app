import { z } from 'zod';
import { ItemStatus } from '../../types/entities.js';

export const isoDateTime = z
    .string()
    .min(1)
    .refine((s) => !Number.isNaN(Date.parse(s)) && /T.*(Z|[+-]\d{2}:\d{2})$/.test(s), {
        message: 'must be an ISO 8601 datetime (e.g. 2026-05-08T10:00:00Z)',
    });

/**
 * Floating wall-clock datetime — accepts the timezone-naive form `YYYY-MM-DDTHH:MM:SS` in addition
 * to the offset-suffixed form. Used for `Item.timeStart` / `Item.timeEnd` because routine-generated
 * calendar items deliberately store a local wall-clock time (e.g. "10:30 every day") and pair it
 * with the calendar's `timeZone` when sent to Google Calendar. Stamping a UTC offset onto these
 * values would shift them by the user's offset on every read.
 *
 * All-day calendar items store a date-only `YYYY-MM-DD` for `timeStart` / `timeEnd` (the GCal
 * `{ date }` form), so the date-only shape is accepted too — otherwise marking an all-day calendar
 * item done would 400 on `snapshot.timeStart` validation.
 */
export const floatingDateTime = z
    .string()
    .min(1)
    .refine(
        (s) =>
            /^\d{4}-\d{2}-\d{2}$/.test(s) ||
            (!Number.isNaN(Date.parse(s)) && (/T.*(Z|[+-]\d{2}:\d{2})$/.test(s) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s))),
        {
            message: 'must be an ISO datetime (with or without timezone suffix) or a YYYY-MM-DD date',
        },
    );

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'must be a YYYY-MM-DD date' });

// Either a calendar date (YYYY-MM-DD) or a full ISO datetime. Several persisted fields use the
// looser shape — `expectedBy`, `ignoreBefore`, and `startDate` are documented as date-only but the
// codebase has historically accepted full datetimes too. Keep the schema permissive here; the
// status-field matrix is the load-bearing rule.
export const isoDateOrDateTime = z
    .string()
    .min(1)
    .refine((s) => /^\d{4}-\d{2}-\d{2}$/.test(s) || (!Number.isNaN(Date.parse(s)) && s.includes('T')), {
        message: 'must be a YYYY-MM-DD date or an ISO 8601 datetime',
    });

export const itemStatusSchema = z.enum(Object.values(ItemStatus) as [string, ...string[]]);

export const energySchema = z.enum(['low', 'medium', 'high']);

export const entityTypeSchema = z.enum(['item', 'routine', 'person', 'workContext']);
export const opTypeSchema = z.enum(['create', 'update', 'delete']);

// RFC 5545 RRULE — looser regex than full validation. Must contain FREQ= so we catch obvious
// misuse (e.g. an empty string from a buggy client) without rebuilding the full RRULE grammar.
export const rruleSchema = z.string().regex(/FREQ=/, { message: 'rrule must contain FREQ=' });

export const nonEmptyString = z.string().min(1);

/**
 * GCal-mirror schemas (organizer/creator/attendees/responseStatus/eventType). Shared between item
 * and routine snapshot validators so the strict-mode round-trip accepts the same shape on both
 * surfaces. Mirrors `GCalPerson` / `GCalAttendee` / `GCalResponseStatus` / `GCalEventType` in
 * `types/entities.ts`.
 */
export const gcalResponseStatusSchema = z.enum(['needsAction', 'accepted', 'declined', 'tentative']);
export const gcalPersonSchema = z
    .object({
        email: nonEmptyString,
        displayName: z.string().optional(),
        self: z.boolean().optional(),
    })
    .strict();
export const gcalAttendeeSchema = z
    .object({
        email: nonEmptyString,
        displayName: z.string().optional(),
        self: z.boolean().optional(),
        responseStatus: gcalResponseStatusSchema,
        organizer: z.boolean().optional(),
        optional: z.boolean().optional(),
    })
    .strict();
// Keep in lockstep with `GCalEventType` in entities.ts. `fromGmail` is Google's value for
// events auto-created from Gmail attachments — it appears in real GCal payloads, so rejecting
// it here would 400 every sync push that echoes such an item back.
export const gcalEventTypeSchema = z.enum(['default', 'outOfOffice', 'focusTime', 'workingLocation', 'fromGmail']);
