import { z } from 'zod';
import { isoDateTime, nonEmptyString } from './shared.js';

export const WorkContextSnapshotSchema = z
    .object({
        _id: nonEmptyString,
        user: nonEmptyString,
        name: z.string(),
        archived: z.boolean().optional(),
        createdTs: isoDateTime,
        updatedTs: isoDateTime,
    })
    .strict();

export const WorkContextCreateSchema = z.object({
    entityType: z.literal('workContext'),
    opType: z.literal('create'),
    entityId: nonEmptyString,
    snapshot: WorkContextSnapshotSchema,
});

export const WorkContextUpdateSchema = z.object({
    entityType: z.literal('workContext'),
    opType: z.literal('update'),
    entityId: nonEmptyString,
    snapshot: WorkContextSnapshotSchema,
});

export const WorkContextDeleteSchema = z.object({
    entityType: z.literal('workContext'),
    opType: z.literal('delete'),
    entityId: nonEmptyString,
    snapshot: z.null(),
});
