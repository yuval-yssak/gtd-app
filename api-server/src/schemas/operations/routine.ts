import { z } from 'zod';
import { energySchema, floatingDateTime, isoDate, isoDateOrDateTime, isoDateTime, nonEmptyString, rruleSchema } from './shared.js';

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
    })
    .strict();

const calendarItemTemplateSchema = z
    .object({
        timeOfDay: z.string().regex(/^\d{2}:\d{2}$/, { message: 'timeOfDay must be HH:MM' }),
        duration: z.number().positive(),
    })
    .strict();

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
        template: routineItemTemplateSchema,
        active: z.boolean(),
        createdTs: isoDateTime,
        updatedTs: isoDateTime,
        startDate: isoDate.optional(),
        calendarItemTemplate: calendarItemTemplateSchema.optional(),
        lastGeneratedDate: isoDateOrDateTime.optional(),
        routineExceptions: z.array(routineExceptionSchema).optional(),
    })
    .strict();

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
