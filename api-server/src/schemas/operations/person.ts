import { z } from 'zod';
import { isoDateTime, nonEmptyString } from './shared.js';

export const PersonSnapshotSchema = z
    .object({
        _id: nonEmptyString,
        user: nonEmptyString,
        name: z.string(),
        email: z.string().optional(),
        phone: z.string().optional(),
        externalCalendarId: nonEmptyString.optional(),
        notes: z.string().optional(),
        createdTs: isoDateTime,
        updatedTs: isoDateTime,
    })
    .strict();

export const PersonCreateSchema = z.object({
    entityType: z.literal('person'),
    opType: z.literal('create'),
    entityId: nonEmptyString,
    snapshot: PersonSnapshotSchema,
});

export const PersonUpdateSchema = z.object({
    entityType: z.literal('person'),
    opType: z.literal('update'),
    entityId: nonEmptyString,
    snapshot: PersonSnapshotSchema,
});

export const PersonDeleteSchema = z.object({
    entityType: z.literal('person'),
    opType: z.literal('delete'),
    entityId: nonEmptyString,
    snapshot: z.null(),
});
