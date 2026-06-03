import { z } from 'zod';
import {
    energySchema,
    floatingDateTime,
    gcalAttendeeSchema,
    gcalEventTypeSchema,
    gcalPersonSchema,
    gcalResponseStatusSchema,
    isoDate,
    isoDateOrDateTime,
    isoDateTime,
    nonEmptyString,
    rruleSchema,
} from './shared.js';

const routineItemTemplateSchema = z
    .object({
        workContextIds: z.array(nonEmptyString).optional(),
        peopleIds: z.array(nonEmptyString).optional(),
        energy: energySchema.optional(),
        time: z.number().nonnegative().optional(),
        focus: z.boolean().optional(),
        urgent: z.boolean().optional(),
        notes: z.string().optional(),
    })
    .strict();

const routineExceptionSchema = z
    .object({
        date: isoDateOrDateTime,
        type: z.enum(['skipped', 'modified']),
        itemId: nonEmptyString.optional(),
        // Floating wall-clock — see Item.timeStart/timeEnd.
        newTimeStart: floatingDateTime.optional(),
        newTimeEnd: floatingDateTime.optional(),
        title: z.string().optional(),
        notes: z.string().optional(),
        // Per-instance GCal-owned overrides — absent means "inherit from master". See entities.ts.
        organizer: gcalPersonSchema.optional(),
        creator: gcalPersonSchema.optional(),
        attendees: z.array(gcalAttendeeSchema).optional(),
        responseStatus: gcalResponseStatusSchema.optional(),
        eventType: gcalEventTypeSchema.optional(),
        meetingLink: z.string().optional(),
        location: z.string().optional(),
        htmlLink: z.string().optional(),
    })
    .strict();

const calendarItemTemplateSchema = z
    .object({
        timeOfDay: z.string().regex(/^\d{2}:\d{2}$/, { message: 'timeOfDay must be HH:MM' }),
        duration: z.number().positive(),
    })
    .strict();

// GCal-owned routine fields (organizer/creator/attendees/responseStatus/eventType) only apply to
// calendar-type routines — a nextAction routine has no GCal master event, so carrying them through
// /sync/push is a contract violation (likely a stale client mirroring fields that should have been
// stripped on routineType change). Reject at the schema layer.
const GCAL_OWNED_ROUTINE_FIELD_NAMES = ['organizer', 'creator', 'attendees', 'responseStatus', 'eventType', 'meetingLink', 'location', 'htmlLink'] as const;

export const RoutineSnapshotSchema = z
    .object({
        _id: nonEmptyString,
        user: nonEmptyString,
        title: z.string(),
        routineType: z.enum(['nextAction', 'calendar']),
        rrule: rruleSchema,
        triggerMode: z.enum(['afterCompletion', 'fixedSchedule']).optional(),
        afterCompletionDelayDays: z.number().nonnegative().optional(),
        calendarEventId: nonEmptyString.optional(),
        calendarIntegrationId: nonEmptyString.optional(),
        calendarSyncConfigId: nonEmptyString.optional(),
        // Disconnect-with-keep markers — see Item.lastKnown* note.
        lastKnownCalendarEventId: nonEmptyString.optional(),
        lastKnownCalendarIntegrationId: nonEmptyString.optional(),
        lastKnownCalendarSyncConfigId: nonEmptyString.optional(),
        splitFromRoutineId: nonEmptyString.optional(),
        lastPushedToGCalTs: isoDateTime.optional(),
        lastSyncedNotes: z.string().optional(),
        // GCal master-mirror fields — see entities.ts GCAL_OWNED_ROUTINE_KEYS.
        organizer: gcalPersonSchema.optional(),
        creator: gcalPersonSchema.optional(),
        attendees: z.array(gcalAttendeeSchema).optional(),
        responseStatus: gcalResponseStatusSchema.optional(),
        eventType: gcalEventTypeSchema.optional(),
        meetingLink: z.string().optional(),
        location: z.string().optional(),
        htmlLink: z.string().optional(),
        template: routineItemTemplateSchema,
        active: z.boolean(),
        createdTs: isoDateTime,
        updatedTs: isoDateTime,
        startDate: isoDate.optional(),
        calendarItemTemplate: calendarItemTemplateSchema.optional(),
        lastGeneratedDate: isoDateOrDateTime.optional(),
        routineExceptions: z.array(routineExceptionSchema).optional(),
    })
    .strict()
    .superRefine((routine, ctx) => {
        if (routine.routineType !== 'calendar') {
            for (const key of GCAL_OWNED_ROUTINE_FIELD_NAMES) {
                if (routine[key] !== undefined) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        path: [key],
                        message: `field "${key}" is only allowed on calendar routines (routineType=${routine.routineType})`,
                    });
                }
            }
        }
    });

export const RoutineCreateSchema = z.object({
    entityType: z.literal('routine'),
    opType: z.literal('create'),
    entityId: nonEmptyString,
    snapshot: RoutineSnapshotSchema,
});

export const RoutineUpdateSchema = z.object({
    entityType: z.literal('routine'),
    opType: z.literal('update'),
    entityId: nonEmptyString,
    snapshot: RoutineSnapshotSchema,
});

// Routine deletes ship snapshot=null from the client; the server hydrates from DB before apply.
export const RoutineDeleteSchema = z.object({
    entityType: z.literal('routine'),
    opType: z.literal('delete'),
    entityId: nonEmptyString,
    snapshot: z.null(),
});
